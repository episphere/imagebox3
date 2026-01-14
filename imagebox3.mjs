import { fromBlob, fromUrl, Pool, getDecoder, addDecoder, globals } from "https://cdn.jsdelivr.net/npm/geotiff@2.1.2/+esm"
// import { fromBlob, fromUrl, Pool, getDecoder, globals } from "./geotiff.js"

class GeoTIFFDriver {
  constructor(imageSource, imageboxInstance) {
    this.source = imageSource;
    this.tiff = null;
    this.parent = imageboxInstance;
  }

  async init(imageSource) {
    if (imageSource) {
      this.source = imageSource
    }
    this.tiff = await getImagePyramid(this.source, true);

    this.tiff.allImages = await getAllImagesInPyramid(this.tiff);
    this.tiff.imageSets = await getImageSetsInPyramid(this.tiff);
    this.tiff.slideImages = await getSlideImagesInPyramid(this.tiff);

    // Pre-calculate ratios for fast lookup in getTile
    const maxImageWidth = this.tiff.slideImages[0].getWidth();
    this.tiff.imageWidthRatios = this.tiff.slideImages.map(img => maxImageWidth / img.getWidth());

    const { width, height } = this.tiff.slideImages.reduce((dims, img) => {
      const w = img.getWidth();
      if (dims.width < w) {
        dims.width = w;
        dims.height = img.getHeight();
      }
      return dims;
    }, { width: 0, height: 0 });

    this.tiff.maxWidth = width;
    this.tiff.maxHeight = height;
    this.parent.tiff = this.tiff
  }

  async getInfo() {
    return await getImageInfo(this.tiff);
  }

  async getTile(x, y, width, height, resolution) {
    const tileParams = {
      tileX: x, tileY: y, tileWidth: width, tileHeight: height,
      tileResolution: resolution || Math.max(width, height)
    };
    return await getImageTile(this.tiff, tileParams, this.parent.workerPool);
  }

  async getThumbnail(w, h) {
    const tileParams = { thumbnailWidthToRender: w, thumbnailHeightToRender: h };
    return await getImageThumbnail(this.tiff, tileParams, this.parent.workerPool);
  }

  destroy() {
    // GeoTIFF is stateless/buffer based, mostly no-op usually
  }
}

class OpenSlideDriver {
  constructor(imageSource, imageboxInstance) {
    this.source = imageSource;
    this.parent = imageboxInstance
    this.os = null;
    this.slide = null
    this.numWorkers = imageboxInstance.numWorkers || 1;
  }

  async init(imageSource) {
    if (imageSource) {
      this.source = imageSource
    }

    const { default: OpenSlide } = await import('https://prafulb.github.io/WSITileSource/openslide-wasm/openslide.js')
    this.os = new OpenSlide({ workers: this.numWorkers || 5 });
    await this.os.initialize()
    // WARNING: For remote URLs, ensure that openslide-wasm
    // supports lazy-loading via HTTP Range requests.
    // If it downloads the whole file, this will fail for large WSIs.
    this.slide = await this.os.open(this.source);

    // Cache level dimensions and count to avoid repeated worker round-trips
    this.levelCount = await this.slide.getLevelCount();
    this.levelDimensions = [];
    for (let i = 0; i < this.levelCount; i++) {
      this.levelDimensions[i] = await this.slide.getLevelDimensions(i);
    }

    const { width, height } = await this.getInfo()
    this.slide.maxWidth = width
    this.slide.maxHeight = height
    this.parent.tiff = this.slide
  }

  async getInfo() {
    if (this._info) return this._info;
    const [width, height] = this.levelDimensions[0];

    const mppX = await this.slide.getPropertyValue("openslide.mpp-x");
    const pixelsPerMicron = mppX ? 1 / parseFloat(mppX) : undefined;

    this._info = { width, height, pixelsPerMicron };
    return this._info;
  }

  async getTile(x, y, width, height, resolution) {
    const downsample = width / resolution;
    const level = await this.slide.getBestLevelForDownsample(downsample);
    const [levelWidth, levelHeight] = this.levelDimensions[level];
    const [fullImageWidth, fullImageHeight] = this.levelDimensions[0];

    const tileWidth = Math.ceil(width * levelWidth / fullImageWidth)
    const tileHeight = Math.ceil(height * levelHeight / fullImageHeight)
    const ratio = height / width;
    const renderWidth = Math.floor(resolution);
    const renderHeight = Math.floor(resolution * ratio);

    const pixelData = await this.slide.readRegion(x, y, level, tileWidth, tileHeight);

    return await this.rgbaToBlob(pixelData, tileWidth, tileHeight, renderWidth, renderHeight);
  }

  async getThumbnail(w, h) {
    const [fullW, fullH] = await this.slide.getLevelDimensions(0);
    return this.getTile(0, 0, fullW, fullH, Math.max(w, h));
  }

  async rgbaToBlob(data, tileWidth, tileHeight, renderWidth, renderHeight) {
    // Use Shared OffscreenCanvas to convert raw RGBA pixels to a PNG Blob
    const cv = utils.getCanvas(renderWidth, renderHeight);
    const ctx = cv.getContext("2d");
    const imageData = new ImageData(data, tileWidth, tileHeight);
    const imageBitmap = await createImageBitmap(imageData, 0, 0, tileWidth, tileHeight, {
      resizeWidth: renderWidth,
      resizeHeight: renderHeight,
      resizeQuality: "high"
    })
    ctx.drawImage(imageBitmap, 0, 0);
    return await cv.convertToBlob({ type: "image/png" });
  }

  destroy() {
    this.slide?.close();
    this.os?.terminate();
  }
}

/* Class representing an Imagebox3 instance of a whole slide image. */
class Imagebox3 {

  /** 
   * Create an Imagebox3 instance.
   * @constructor
   * @param {File|string} imageSource - (Required) The local File object or the remote URL referencing the TIFF file.
   * @param {number} [numWorkers] - The number of web workers to be used to to decode image tiles. Defaults to 0, meaning all decoding operations are performed on the main thread.
   */
  constructor(imageSource, numWorkers, openslideOnly = false) {
    if (imageSource instanceof File || typeof (imageSource) === 'string') {
      this.imageSource = typeof (imageSource) === 'string' ? decodeURIComponent(imageSource) : imageSource
    } else {
      throw new Error("Unsupported image type for ImageBox3")
    }

    this.tiff = undefined
    this.numWorkers = Number.isInteger(numWorkers) ? numWorkers : 0
    this.workerPool = undefined
    this.supportedDecoders = undefined

    const srcName = (imageSource instanceof File) ? imageSource.name : imageSource;
    const isTiffOrSVS = srcName.match(/\.(tif|tiff|svs|gtiff)$/i);

    if (!openslideOnly && isTiffOrSVS) {
      this.driver = new GeoTIFFDriver(this.imageSource, this);
    } else {
      // Fallback to OpenSlide for ndpi, mrxs, vms, etc.
      this.driver = new OpenSlideDriver(this.imageSource, this);
    }
  }

  /**
   * Initialize the created Imagebox3 instance by retrieving all Image File Directory metadata from the TIFF file.
   * This function needs to be called after instantiation. Any operations should be performed only after the returned Promise is fulfilled.
   * @async
   * @return {Promise}
   */
  async init(imageSource) {
    if (imageSource) {
      this.imageSource = typeof (imageSource) === 'string' ? decodeURIComponent(imageSource) : imageSource
    }
    await this.driver.init(this.imageSource);
  }

  /**
   * Retrieve the image source to the TIFF file that the current Imagebox3 instance is using.
   * @returns {File|string} - The local File object or the remote URL referencing the TIFF file.
   */
  getImageSource() {
    return this.imageSource
  }

  /**
   * Switch image sources without destroying the Imagebox3 instance. Recommended when a new image needs to be loaded instead of
   * re-instantiating Imagebox3, so as to avoid spawning a new worker pool. Await the fulfilment of the returned Promise
   * before running further operations.
   * @async
   * @param {File|string} newImageSource - The local File object or the remote URL referencing the new TIFF file.
   * @returns {Promise}
   */
  async changeImageSource(newImageSource) {
    // USE INSTEAD OF RE-INSTANTIATING IMAGEBOX3 FOR EACH NEW IMAGE TO AVOID SPAWNING A NEW WORKER POOL EVERY TIME!!!
    // IT IS NECESSARY TO HAVE THE WORKER POOL CREATION BE TIED TO THE INSTANTIATION BECAUSE COMPRESSION METHODS COULD BE DIFFERENT
    // IN DIFFERENT IMAGES, MEANING THE SAME WORKER POOL MIGHT NOT BE REPURPOSEABLE. 
    await this.init(newImageSource)
  }

  /**
   * Retrieve the TIFF metadata obejct containing information about the image pyramid.
   * @returns {Object}
   */
  getPyramid() {
    return this.tiff
  }

  /**
   * Create a new pool of web workers to be used for decoding image tiles based on the supported decoders. Highly recommended if retrieving
   * multiple patches parallelly. Destroys all previously created Imagebox3 worker pools before creating a new one.
   * @async
   * @param {number} numWorkers The number of web workers in the decoder pool. Defaults to 0, meaning all operations will be performed on the main thread.
   * @returns {Object}
   */
  async createWorkerPool(numWorkers) {
    if (this.workerPool && this.numWorkers === numWorkers) {
      return this.workerPool;
    }
    if (this.workerPool) {
      destroyPool(this.workerPool)
    }
    // Setup decoders and pool lazily
    await this.getSupportedDecoders();
    this.workerPool = await createPool(await this.tiff.getImage(0), numWorkers, this.supportedDecoders)
    this.numWorkers = numWorkers
    return this.workerPool
  }

  /**
   * Destroy the current pool of web workers. Highly recommended if re-instantiating Imagebox3 to avoid zombie web workers
   * from slowing down the client, since web workers are not destroyed even if their initiator is garbage-colleged.
   */
  destroyWorkerPool() {
    // HIGHLY RECOMMENDED WHEN LOADING A NEW IMAGE!!! OTHERWISE EACH NEW INSTANTATION WILL CREATE A NEW WORKER POOL!!!!!
    destroyPool(this.workerPool)
    if (this.driver.destroy) this.driver.destroy();
  }

  /**
   * Get the compression schemes (as specified in the TIFF format specification) that Imagebox3 can decode. 
   * JPEG/LZW/Deflate/WebP are automatically supported, along with JPEG-2000 which is added as an external decoder 
   * only if needed.
   * @async
   * @returns {string[]}
   */
  async getSupportedDecoders() {
    // TODO: Make it possible for users to provide custom decoders.
    this.supportedDecoders = this.supportedDecoders || await setupDecoders()
    return this.supportedDecoders
  }

  /**
   * Retrieve basic information about the largest image in the TIFF. Currently returns the image width and height, 
   * and the pixels per micron corresponding to the slide.
   * @async
   * @returns {Object}
   */
  async getInfo() {
    return await this.driver.getInfo();
  }

  /**
   * Retrieve a thumbnail representation of the whole slide image from the TIFF.
   * @async
   * @param {number} thumbnailWidth - The width of the thumbnail image to be returned.
   * @param {number} thumbnailHeight - The height of the thumbnail image to be returned.
   * @returns {Blob}
   */
  async getThumbnail(thumbnailWidth, thumbnailHeight) {
    return await this.driver.getThumbnail(thumbnailWidth, thumbnailHeight);
  }

  /**
   * Retrieve a single tile from the whole slide corresponding to the bounding box formed by the parameters and at the specified resolution. The bounding box
   * should always be parameterized as per the largest image representation in the TIFF pyramid. By default, the optimal image from which to retrieve
   * the tile is estimated heuristically, based on the size of the bounding box and the requested resolution.
   * @async
   * @param {number} topLeftX - The X coordinate of the top-left corner of the bounding box for the tile to be retrieved.
   * @param {number} topLeftY - The Y coordinate of the top-left corner of the bounding box for the tile to be retrieved.
   * @param {number} tileWidthInImage - The width of the bounding box for the tile.
   * @param {number} tileHeightInImage - The height of the bounding box for the tile.
   * @param {number} tileResolutionToRender - The resolution in which the tile should be returned.
   * @param {number} [imageIndex] - The index of the image in the pyramid to be specifically used to retrieve the tile.
   * @returns {Blob}
   */
  async getTile(topLeftX, topLeftY, tileWidthInImage, tileHeightInImage, tileResolutionToRender, imageIndex = -1) {
    if (this.driver instanceof GeoTIFFDriver && !this.workerPool && this.numWorkers > 0) {
      await this.createWorkerPool(this.numWorkers);
    }
    return await this.driver.getTile(topLeftX, topLeftY, tileWidthInImage, tileHeightInImage, tileResolutionToRender);
  }

  /**
   * Retrieve the number of images in the TIFF image pyramid.
   * @returns {number}
   */
  getImageCount() {
    return this.tiff?.ifdRequests?.length
  }

}

const utils = {
  parseTileParams: (p) => {
    return {
      tileX: parseInt(p.tileX),
      tileY: parseInt(p.tileY),
      tileWidth: parseInt(p.tileWidth),
      tileHeight: parseInt(p.tileHeight),
      tileSize: parseInt(p.tileSize),
      tileResolution: parseInt(p.tileResolution),
      thumbnailWidthToRender: parseInt(p.thumbnailWidthToRender),
      thumbnailHeightToRender: parseInt(p.thumbnailHeightToRender)
    };
  },

  getImageByRatio: async (imagePyramid, tileWidth, tileWidthToRender) => {
    const tileWidthRatio = Math.floor(tileWidth / tileWidthToRender)
    const slideImages = imagePyramid.slideImages || await getSlideImagesInPyramid(imagePyramid)
    const imageWidthRatios = imagePyramid.imageWidthRatios || slideImages.map(img => slideImages[0].getWidth() / img.getWidth());

    // sortedRatios without the thumbnail (last element)
    const sortedRatios = imageWidthRatios.slice(0, -1);

    if (tileWidthRatio >= sortedRatios[sortedRatios.length - 1]) {
      return slideImages[sortedRatios.length - 1];
    }
    if (tileWidthRatio <= sortedRatios[1]) {
      return slideImages[0];
    }

    for (let i = 1; i < sortedRatios.length - 1; i++) {
      if (tileWidthRatio >= sortedRatios[i] && tileWidthRatio <= sortedRatios[i + 1]) {
        return slideImages[i];
      }
    }
    return slideImages[0];
  },

  handleConversion: (data, imageFileDirectory) => {
    // Converters copied from pearcetm/GeoTIFFTileSource
    const Converters = {
      RGBAfromYCbCr: (input) => {
        const rgbaRaster = new Uint8ClampedArray(input.length * 4 / 3);
        let i, j;
        for (i = 0, j = 0; i < input.length; i += 3, j += 4) {
          const y = input[i];
          const cb = input[i + 1];
          const cr = input[i + 2];

          rgbaRaster[j] = (y + (1.40200 * (cr - 0x80)));
          rgbaRaster[j + 1] = (y - (0.34414 * (cb - 0x80)) - (0.71414 * (cr - 0x80)));
          rgbaRaster[j + 2] = (y + (1.77200 * (cb - 0x80)));
          rgbaRaster[j + 3] = 255;
        }
        return rgbaRaster;
      },
      RGBAfromRGB: (input) => {
        const rgbaRaster = new Uint8ClampedArray(input.length * 4 / 3);
        const rgba32 = new Uint32Array(rgbaRaster.buffer);
        let i, j;
        for (i = 0, j = 0; i < input.length; i += 3, j += 1) {
          // Optimized pixel packing (Little Endian assumed for browser)
          rgba32[j] = (255 << 24) | (input[i + 2] << 16) | (input[i + 1] << 8) | input[i];
        }
        return rgbaRaster;
      },
      RGBAfromWhiteIsZero: (input, max) => {
        const rgbaRaster = new Uint8ClampedArray(input.length * 4);
        let value;
        for (let i = 0, j = 0; i < input.length; ++i, j += 3) {
          value = 256 - (input[i] / max * 256);
          rgbaRaster[j] = value;
          rgbaRaster[j + 1] = value;
          rgbaRaster[j + 2] = value;
          rgbaRaster[j + 3] = 255;
        }
        return rgbaRaster;
      },
      RGBAfromBlackIsZero: (input, max) => {
        const rgbaRaster = new Uint8ClampedArray(input.length * 4);
        let value;
        for (let i = 0, j = 0; i < input.length; ++i, j += 3) {
          value = input[i] / max * 256;
          rgbaRaster[j] = value;
          rgbaRaster[j + 1] = value;
          rgbaRaster[j + 2] = value;
          rgbaRaster[j + 3] = 255;
        }
        return rgbaRaster;
      },
      RGBAfromPalette: (input, colorMap) => {
        const rgbaRaster = new Uint8ClampedArray(input.length * 4);
        const greenOffset = colorMap.length / 3;
        const blueOffset = colorMap.length / 3 * 2;
        for (let i = 0, j = 0; i < input.length; ++i, j += 3) {
          const mapIndex = input[i];
          rgbaRaster[j] = colorMap[mapIndex] / 65536 * 256;
          rgbaRaster[j + 1] = colorMap[mapIndex + greenOffset] / 65536 * 256;
          rgbaRaster[j + 2] = colorMap[mapIndex + blueOffset] / 65536 * 256;
          rgbaRaster[j + 3] = 255;
        }
        return rgbaRaster;
      },
      RGBAfromCMYK: (input) => {
        const rgbaRaster = new Uint8ClampedArray(input.length);
        for (let i = 0, j = 0; i < input.length; i += 4, j += 4) {
          const c = input[i];
          const m = input[i + 1];
          const y = input[i + 2];
          const k = input[i + 3];

          rgbaRaster[j] = 255 * ((255 - c) / 256) * ((255 - k) / 256);
          rgbaRaster[j + 1] = 255 * ((255 - m) / 256) * ((255 - k) / 256);
          rgbaRaster[j + 2] = 255 * ((255 - y) / 256) * ((255 - k) / 256);
          rgbaRaster[j + 3] = 255;
        }
        return rgbaRaster;
      },
      RGBAfromCIELab: (input) => {
        // from https://github.com/antimatter15/rgb-lab/blob/master/color.js
        const Xn = 0.95047;
        const Yn = 1.00000;
        const Zn = 1.08883;
        const rgbaRaster = new Uint8ClampedArray(input.length * 4 / 3);

        for (let i = 0, j = 0; i < input.length; i += 3, j += 4) {
          const L = input[i + 0];
          const a_ = input[i + 1] << 24 >> 24; // conversion from uint8 to int8
          const b_ = input[i + 2] << 24 >> 24; // same

          let y = (L + 16) / 116;
          let x = (a_ / 500) + y;
          let z = y - (b_ / 200);
          let r;
          let g;
          let b;

          x = Xn * ((x * x * x > 0.008856) ? x * x * x : (x - (16 / 116)) / 7.787);
          y = Yn * ((y * y * y > 0.008856) ? y * y * y : (y - (16 / 116)) / 7.787);
          z = Zn * ((z * z * z > 0.008856) ? z * z * z : (z - (16 / 116)) / 7.787);

          r = (x * 3.2406) + (y * -1.5372) + (z * -0.4986);
          g = (x * -0.9689) + (y * 1.8758) + (z * 0.0415);
          b = (x * 0.0557) + (y * -0.2040) + (z * 1.0570);

          r = (r > 0.0031308) ? ((1.055 * (r ** (1 / 2.4))) - 0.055) : 12.92 * r;
          g = (g > 0.0031308) ? ((1.055 * (g ** (1 / 2.4))) - 0.055) : 12.92 * g;
          b = (b > 0.0031308) ? ((1.055 * (b ** (1 / 2.4))) - 0.055) : 12.92 * b;

          rgbaRaster[j] = Math.max(0, Math.min(1, r)) * 255;
          rgbaRaster[j + 1] = Math.max(0, Math.min(1, g)) * 255;
          rgbaRaster[j + 2] = Math.max(0, Math.min(1, b)) * 255;
          rgbaRaster[j + 3] = 255;
        }
        return rgbaRaster;
      }
    }

    const { PhotometricInterpretation } = imageFileDirectory;
    let imageData;

    switch (PhotometricInterpretation) {
      case globals.photometricInterpretations.WhiteIsZero:  // grayscale, white is zero
        imageData = Converters.RGBAfromWhiteIsZero(data, 2 ** imageFileDirectory.BitsPerSample[0]);
        break;

      case globals.photometricInterpretations.BlackIsZero:  // grayscale, white is zero
        imageData = Converters.RGBAfromBlackIsZero(data, 2 ** imageFileDirectory.BitsPerSample[0]);

        break;

      case globals.photometricInterpretations.RGB:  // RGB
        imageData = Converters.RGBAfromRGB(data);
        break;

      case globals.photometricInterpretations.Palette:  // colormap
        imageData = Converters.RGBAfromPalette(data, 2 ** imageFileDirectory.colorMap);
        break;

      // case globals.photometricInterpretations.TransparencyMask: // Transparency Mask
      // break;

      case globals.photometricInterpretations.CMYK:  // CMYK
        imageData = Converters.RGBAfromCMYK(data);
        break;

      case globals.photometricInterpretations.YCbCr:  // YCbCr
        imageData = Converters.RGBAfromYCbCr(data);
        break;

      case globals.photometricInterpretations.CIELab: // CIELab
        imageData = Converters.RGBAfromCIELab(data);
        break;
    }
    return imageData
  },

  convertToImageBlob: async (data, width, height, imageFileDirectory) => {
    const imageData = await utils.handleConversion(data, imageFileDirectory)
    const cv = utils.getCanvas(width, height);
    const ctx = cv.getContext("2d")
    ctx.putImageData(new ImageData(imageData, width, height), 0, 0)
    return await cv.convertToBlob({
      type: "image/png",
      quality: 1.0,
    })
  },

  _canvas: null,
  getCanvas: (width, height) => {
    if (!utils._canvas) {
      utils._canvas = new OffscreenCanvas(width, height);
    } else {
      utils._canvas.width = width;
      utils._canvas.height = height;
    }
    return utils._canvas;
  }
}

const setupDecoders = async () => {
  const baseURL = import.meta.url.split("/").slice(0, -1).join("/");
  const decodersJSON_URL = `${baseURL}/decoders/decoders.json`;
  return await (await fetch(decodersJSON_URL)).json()
}

export const getImagePyramid = async (imageSource, cache = true) => {
  let tiffPyramid

  try {
    const headers = cache === false ? { headers: { 'Cache-Control': "no-cache, no-store" } } : {}
    tiffPyramid = tiffPyramid || (imageSource instanceof File ? await fromBlob(imageSource) : await fromUrl(imageSource, headers))
  }
  catch (e) {
    console.error("Couldn't get images", e)
    if (cache) { // Retry in case Cache-Control is not part of Access-Control-Allow-Headers in preflight response
      return await getImagePyramid(imageSource, !cache)
    }
  }

  return tiffPyramid
}

export const getAllImagesInPyramid = async (imagePyramid) => {

  if (typeof (imagePyramid?.ifdRequests) !== 'object') {
    throw new Error("Malformed image pyramid. Please retry pyramid creation using the `getImagePyramid()` method.")
  }

  const imageCount = await imagePyramid.getImageCount()

  const imageRequests = [...Array(imageCount)].map((_, ind) => imagePyramid.getImage(ind))
  const resolvedPromises = await Promise.allSettled(imageRequests)

  const resolvedImages = resolvedPromises.filter((promise) => promise.status === 'fulfilled').map(promise => promise.value)

  return resolvedImages
}

export const getImageSetsInPyramid = async (imagePyramid) => {
  // Get all sets of images in the pyramid, based on aspect ratio differences. For instance, there could be a set of images at different
  // resolutions corresponding to the whole slide image, another set corresponding to a meta-image and so on.

  if (typeof (imagePyramid?.ifdRequests) !== 'object') {
    throw new Error("Malformed image pyramid. Please retry pyramid creation using the `getImagePyramid()` method.")
  }

  const allImages = imagePyramid.allImages || await getAllImagesInPyramid(imagePyramid)

  const ASPECT_RATIO_TOLERANCE = 0.01

  const imageSets = allImages
    .filter(image => image.fileDirectory.photometricInterpretation !== globals.photometricInterpretations.TransparencyMask)
    .sort((image1, image2) => image2.getWidth() - image1.getWidth())
    .reduce((sets, image) => {
      const aspectRatio = image.getWidth() / image.getHeight()
      const aspectRatioSetIndex = sets.findIndex(set => Math.abs(set[0].getWidth() / set[0].getHeight() - aspectRatio) < ASPECT_RATIO_TOLERANCE)
      if (aspectRatioSetIndex !== -1) {
        sets[aspectRatioSetIndex].push(image)
      } else {
        sets.push([image])
      }
      return sets
    }, [])

  return imageSets
}

export const getSlideImagesInPyramid = async (imagePyramid) => {
  // Get all images in the pyramid corresponding to the whole slide image. Filter out any meta-images or those with transparent masks.

  if (typeof (imagePyramid?.ifdRequests) !== 'object') {
    throw new Error("Malformed image pyramid. Please retry pyramid creation using the `getImagePyramid()` method.")
  }

  const imageSets = imagePyramid.imageSets || await getImageSetsInPyramid(imagePyramid)

  const bestSet = imageSets.reduce((largestImageSet, set) => {
    if (largestImageSet.length === 0 || largestImageSet[0].getWidth() < set[0].getWidth() || (largestImageSet[0].getWidth() === set[0].getWidth() && largestImageSet.length < set.length)) {
      largestImageSet = set
    }
    return largestImageSet
  }, [])

  return bestSet

}

export const getImageInfo = async (imagePyramid) => {
  // Get basic information about the image (width, height, MPP for now)

  if (typeof (imagePyramid?.ifdRequests) !== 'object') {
    throw new Error("Malformed image pyramid. Please retry pyramid creation using the `getImagePyramid()` method.")
  }

  const slideImages = imagePyramid.slideImages || await getSlideImagesInPyramid(imagePyramid)
  const largestImage = slideImages[0]

  let pixelsPerMicron = undefined
  if (largestImage?.fileDirectory?.ImageDescription && largestImage.fileDirectory.ImageDescription.includes("MPP")) {
    const micronsPerPixel = largestImage.fileDirectory.ImageDescription.split("|").find(s => s.includes("MPP")).split("=")[1].trim()
    pixelsPerMicron = 1 / parseFloat(micronsPerPixel)
  }

  const imageInfo = {
    'width': largestImage.getWidth(),
    'height': largestImage.getHeight(),
    pixelsPerMicron
  }

  return imageInfo
}

export const getImageThumbnail = async (imagePyramid, tileParams, pool) => {

  if (typeof (imagePyramid?.ifdRequests) !== 'object') {
    throw new Error("Malformed image pyramid. Please retry pyramid creation using the `getImagePyramid()` method.")
  }

  const parsedTileParams = utils.parseTileParams(tileParams)
  let { thumbnailWidthToRender, thumbnailHeightToRender } = parsedTileParams

  if (!Number.isInteger(thumbnailWidthToRender) && !Number.isInteger(thumbnailHeightToRender)) {
    throw new Error(`Thumbnail Request missing critical parameters: thumbnailWidthToRender:${thumbnailWidthToRender}, thumbnailHeightToRender:${thumbnailHeightToRender}`)
  }

  let imageWidth = imagePyramid.maxWidth
  let imageHeight = imagePyramid.maxHeight

  if (!imageWidth || !imageHeight) {
    const imageInfo = await (await getImageInfo(imagePyramid)).json()
    imageWidth = imageInfo.width
    imageHeight = imageInfo.height
  }

  const tileSize = Number.isInteger(thumbnailWidthToRender) && Number.isInteger(thumbnailHeightToRender) ? Math.max(thumbnailWidthToRender, thumbnailHeightToRender) : (Number.isInteger(thumbnailWidthToRender) ? thumbnailWidthToRender : thumbnailHeightToRender)

  const thumbnailParams = {
    'tileX': 0,
    'tileY': 0,
    'tileWidth': imageWidth,
    'tileHeight': imageHeight,
    'tileSize': tileSize
  }

  const thumbnailImage = await getImageTile(imagePyramid, thumbnailParams, pool)

  return thumbnailImage

}

export const getImageTile = async (imagePyramid, tileParams, pool, imageIndex = -1) => {
  // Get individual tiles from the appropriate image in the pyramid.

  if (typeof (imagePyramid?.ifdRequests) !== 'object') {
    throw new Error("Malformed image pyramid. Please retry pyramid creation using the `getImagePyramid()` method.")
  }

  const parsedTileParams = utils.parseTileParams(tileParams)
  let { tileX, tileY, tileWidth, tileHeight, tileSize, tileResolution } = parsedTileParams

  if (!Number.isInteger(tileX) || !Number.isInteger(tileY) || !Number.isInteger(tileWidth) || !Number.isInteger(tileHeight)) {
    console.error("Tile Request missing critical parameters!", tileX, tileY, tileWidth, tileHeight)
    return
  }
  if (!Number.isInteger(tileSize) && !Number.isInteger(tileResolution)) {
    tileResolution = Math.max(tileWidth, tileHeight)
  }
  tileResolution = tileResolution || tileSize // To ensure backward compatibility.

  let optimalImageInTiff = undefined
  if (imageIndex >= 0 && imageIndex < imagePyramid.slideImages.length) {
    optimalImageInTiff = imagePyramid.slideImages[imageIndex]
  } else {
    optimalImageInTiff = await utils.getImageByRatio(imagePyramid, tileWidth, tileResolution)
  }
  if (Array.isArray(optimalImageInTiff.fileDirectory["SampleFormat"]) && optimalImageInTiff.fileDirectory["SampleFormat"].length !== optimalImageInTiff.fileDirectory["BitsPerSample"].length) {
    optimalImageInTiff.fileDirectory["SampleFormat"] = Array(optimalImageInTiff.fileDirectory["BitsPerSample"].length).fill(optimalImageInTiff.fileDirectory["SampleFormat"][0])
  }

  const optimalImageWidth = optimalImageInTiff.getWidth()
  const optimalImageHeight = optimalImageInTiff.getHeight()

  let tileWidthToRender, tileHeightToRender
  if (tileWidth > tileHeight) {
    tileHeightToRender = Math.floor(tileHeight * tileResolution / tileWidth)
    tileWidthToRender = tileResolution
  } else {
    tileWidthToRender = Math.floor(tileWidth * tileResolution / tileHeight)
    tileHeightToRender = tileResolution
  }

  const { maxWidth, maxHeight } = imagePyramid

  const tileInImageLeftCoord = Math.max(Math.floor(tileX * optimalImageWidth / maxWidth), 0)
  const tileInImageTopCoord = Math.max(Math.floor(tileY * optimalImageHeight / maxHeight), 0)
  const tileInImageRightCoord = Math.min(Math.floor((tileX + tileWidth) * optimalImageWidth / maxWidth), optimalImageWidth)
  const tileInImageBottomCoord = Math.min(Math.floor((tileY + tileHeight) * optimalImageHeight / maxHeight), optimalImageHeight)

  const geotiffParameters = {
    width: tileWidthToRender,
    height: tileHeightToRender,
    window: [
      tileInImageLeftCoord,
      tileInImageTopCoord,
      tileInImageRightCoord,
      tileInImageBottomCoord,
    ],
    interleave: true
  }

  if (pool) {
    geotiffParameters['pool'] = pool
  }
  else if (!isImageDecodableByDefault(imagePyramid)) {
    // Trying to adhere to new GeoTIFF.js changes in addDecoder (preferWorker etc.) because it fails on
    // JPEG-2K compression files. Wrong way to do it. Check commented code at the bottom of decoders_33005.js
    // to see how a start to how it probably should be done (likely still wrong).
    const decoderForCompression = supportedDecoders?.[imageCompression]
    if (decoderForCompression) {
      await addDecoder(imageCompression, async () => {
        // Needs to import J2KDecoder
        return class JPEG2000Decoder extends GeoTIFF.BaseDecoder {
          constructor(fileDirectory) {
            super();
          }
          decodeBlock(b) {
            let encodedBuffer = decoder.getEncodedBuffer(b.byteLength);
            encodedBuffer.set(new Uint8Array(b));
            decoder.decode();
            let decodedBuffer = decoder.getDecodedBuffer();
            return decodedBuffer.buffer;
          }
        }
      });
    }
  }

  const data = await optimalImageInTiff.readRasters(geotiffParameters)

  const imageBlob = await utils.convertToImageBlob(data, tileWidthToRender, tileHeightToRender, optimalImageInTiff.fileDirectory)
  return imageBlob
}

export const getImageCompression = async (tiffObjOrImage) => {
  if (tiffObjOrImage?.getImage) {
    tiffObjOrImage = await tiffObjOrImage.getImage(0)
  }
  return tiffObjOrImage?.fileDirectory?.Compression
}

export const isImageDecodableByDefault = async (tiffImage) => {
  const imageCompression = await getImageCompression(tiffImage)
  try {
    await getDecoder(tiffImage.fileDirectory)
  } catch (e) {
    if (e.message.includes("Unknown compression method")) {
      return false
    }
  }
  return true
}

export const createPool = async (tiffImage, numWorkers = 0, supportedDecoders) => {
  let workerPool = undefined
  if (typeof (Worker) === 'undefined') {
    console.warn("Worker pool creation failed. The environment does not support web workers. All operations shall run on the main thread.")
    return workerPool
  }

  if (numWorkers === 0) {
    return workerPool
  } else if (Number.isInteger(numWorkers) && numWorkers > 0) {
    if (!supportedDecoders) {
      supportedDecoders = await setupDecoders()
    }
    // Condition to check if this is a service worker-like environment. Service workers cannot create new workers, 
    // plus the GeoTIFF version has to be downgraded to avoid any dynamic imports.
    // As a result, thread creation and non-standard image decoding does not work inside service workers. You would typically 
    // only use service workers to support OpenSeadragon anyway, in which case you'd be better off using something like
    // https://github.com/episphere/GeoTIFFTileSource-JPEG2k .

    const imageCompression = await getImageCompression(tiffImage)
    let createWorker
    const canUseDefaultDecoders = await isImageDecodableByDefault(tiffImage)
    if (!canUseDefaultDecoders) {
      const decoderForCompression = supportedDecoders?.[imageCompression]
      if (decoderForCompression) {
        const baseURL = import.meta.url.split("/").slice(0, -1).join("/");
        createWorker = () => new Worker(URL.createObjectURL(new Blob([`
          importScripts("${baseURL}/decoders/${decoderForCompression}")
        `])));
      } else {
        throw new Error(`Unsupported compression method: ${imageCompression}. Cannot process this image.`)
      }
    }

    workerPool = new Pool(Math.min(Math.floor(navigator.hardwareConcurrency / 2), numWorkers), createWorker)
    workerPool.supportedCompression = imageCompression // Explicitly specify that the current worker pool supports the image's compression scheme.

    await new Promise(res => setTimeout(res, 500)) // Setting up the worker pool is an asynchronous task, give it time to complete before moving on.
  }
  return workerPool
}

export const destroyPool = (workerPool) => {
  workerPool?.destroy()
  workerPool = undefined
  return workerPool
};

export { Imagebox3 }
export default Imagebox3