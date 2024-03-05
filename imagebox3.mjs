// DO NOT USE THIS FILE IN SERVICE WORKERS. USE imagebox3.js INSTEAD.

import { fromBlob, fromUrl, Pool, getDecoder, globals } from "https://cdn.jsdelivr.net/npm/geotiff@2.1.2/+esm"

class Imagebox3 {
  constructor(imageSource, numWorkers) {
    if (imageSource instanceof File || typeof (imageSource) === 'string') {
      this.imageSource = typeof (imageSource) === 'string' ? decodeURIComponent(imageSource) : imageSource
    } else {
      throw new Error("Unsupported image type for ImageBox3")
    }

    this.tiff = undefined
    this.numWorkers = typeof (numWorkers) === 'number' ? numWorkers : Math.max(Math.floor(navigator.hardwareConcurrency / 2), 1)
    this.workerPool = undefined
    this.supportedDecoders = undefined
  }

  async init() {
    this.tiff = await getImagePyramid(this.imageSource, true)
    const imagesInPyramid = await getAllImagesInPyramid(this.tiff)

    const { width: maxWidth, height: maxHeight } = imagesInPyramid.reduce((largestImageDimensions, image) => {
      if (largestImageDimensions.width < image.getWidth() && largestImageDimensions.height < image.getHeight()) {
        largestImageDimensions.width = image.getWidth()
        largestImageDimensions.height = image.getHeight()
      }
      return largestImageDimensions
    }, { width: 0, height: 0 })

    this.tiff.maxWidth = maxWidth
    this.tiff.maxHeight = maxHeight

    await this.getSupportedDecoders()
    await this.createWorkerPool(this.numWorkers)
  }

  getImageSource() {
    return this.imageSource
  }

  async changeImageSource(newImageSource) {
    this.imageSource = typeof (newImageSource) === 'string' ? decodeURIComponent(newImageSource) : newImageSource
    await this.init()
  }

  getPyramid() {
    return this.tiff
  }

  async createWorkerPool(numWorkers) {
    // TODO: Load only the decoders necessary for the current image, instead of having them all active.
    if (this.workerPool) {
      destroyPool(this.workerPool)
    }
    this.workerPool = await createPool(await this.tiff.getImage(0), numWorkers, this.supportedDecoders)
    this.numWorkers = numWorkers
    return this.workerPool
  }

  destroyWorkerPool() {
    destroyPool(this.workerPool)
  }

  async getSupportedDecoders() {
    this.supportedDecoders = this.supportedDecoders || await setupDecoders()
    return this.supportedDecoders
  }

  async getInfo() {
    return await getImageInfo(this.tiff)
  }

  async getThumbnail(thumbnailWidth, thumbnailHeight) {
    const tileParams = {
      thumbnailWidthToRender: thumbnailWidth,
      thumbnailHeightToRender: thumbnailHeight
    }
    return await getImageThumbnail(this.tiff, tileParams, this.workerPool)
  }

  async getTile(topLeftX, topLeftY, tileWidthInImage, tileHeightInImage, tileSizeToRender) {
    const tileParams = {
      tileX: topLeftX,
      tileY: topLeftY,
      tileWidth: tileWidthInImage,
      tileHeight: tileHeightInImage,
      tileSize: tileSizeToRender
    }
    return await getImageTile(this.tiff, tileParams, this.workerPool)
  }

}

const utils = {
  parseTileParams: (tileParams) => {
    // Parse tile params into tile coordinates and size
    const parsedTileParams = Object.entries(tileParams).reduce((parsed, [key, val]) => {
      if (!isNaN(val)) {
        parsed[key] = parseInt(val)
      }
      return parsed
    }, {})

    return parsedTileParams
  },

  getImageByRatio: async (imagePyramid, tileWidth, tileWidthToRender) => {
    // Return the index of the appropriate image in the pyramid for the requested tile
    // by comparing the ratio of the width of the requested tile and the requested resolution, 
    // and comparing it against the ratios of the widths of all images in the pyramid to the largest image.
    // This is a heuristic that is used to determine the best image to use for a given tile request.
    // Could be optimized further?

    const tileWidthRatio = Math.floor(tileWidth / tileWidthToRender)
    let bestImageIndex = 0
    let imageWidthRatios = []
    // if (!tiffPyramid.imageWidthRatios) {
    //   tiffPyramid.imageWidthRatios = []
      const slideImages = await getSlideImagesInPyramid(imagePyramid)
      for (let imageIndex = 0; imageIndex < slideImages.length; imageIndex++) {
        const imageWidth = slideImages[imageIndex].getWidth()
        const maxImageWidth = slideImages[0].getWidth()
        imageWidthRatios.push(maxImageWidth / imageWidth)
      }

    // }
// 
    const sortedRatios = [...imageWidthRatios].sort((a, b) => a - b).slice(0, -1) // Remove thumbnail from consideration

    // If the requested resolution is less than 1/8th the requested tile width, the smallest image should suffice.
    if (tileWidthRatio >= sortedRatios[sortedRatios.length - 1]) {
      bestImageIndex = imageWidthRatios.indexOf(sortedRatios[sortedRatios.length - 1])

    }
    else if (tileWidthRatio <= sortedRatios[1]) {
      // Return the largest image for high magnification tiles
      bestImageIndex = imageWidthRatios.indexOf(sortedRatios[0])
    }

    // If the requested resolution is between the highest and lowest resolution images in the pyramid, 
    // return the smallest image with resolution ratio greater than the requested resolution.
    else {
      const otherRatios = sortedRatios.slice(1, sortedRatios.length - 1)
      if (otherRatios.length === 1) {
        bestImageIndex = imageWidthRatios.indexOf(otherRatios[0])
      } else {
        otherRatios.forEach((ratio, index) => {
          if (tileWidthRatio >= ratio && tileWidthRatio <= sortedRatios[index + 2]) {
            bestImageIndex = imageWidthRatios.indexOf(otherRatios[index])
          }
        })
      }
    }
    return slideImages[bestImageIndex]
  },

  convertToImageBlob: async (data, width, height, imageFileDirectory) => {
    // TODO: Write Node.js module to convert to image

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
        let i, j;
        for (i = 0, j = 0; i < input.length; i += 3, j += 4) {
          rgbaRaster[j] = input[i];
          rgbaRaster[j + 1] = input[i + 1];
          rgbaRaster[j + 2] = input[i + 2];
          rgbaRaster[j + 3] = 255;
        }
        return rgbaRaster;
      },
      RGBAfromWhiteIsZero: (input, max) => {
        const rgbaRaster = new Uint8Array(input.length * 4);
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
        const rgbaRaster = new Uint8Array(input.length * 4);
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
        const rgbaRaster = new Uint8Array(input.length * 4);
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
        const rgbaRaster = new Uint8Array(input.length);
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
        const rgbaRaster = new Uint8Array(input.length * 4 / 3);

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

    const cv = new OffscreenCanvas(width, height) // Use OffscreenCanvas so it works in workers as well.
    const ctx = cv.getContext("2d")
    ctx.putImageData(new ImageData(imageData, width, height), 0, 0)
    const blob = await cv.convertToBlob({
      type: "image/jpeg",
      quality: 1.0,
    })

    const response = new Response(blob, { status: 200 })
    return response
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
    const headers = cache ? { headers: { 'Cache-Control': "no-cache, no-store" } } : {}
    tiffPyramid = tiffPyramid || (imageSource instanceof File ? await fromBlob(imageSource) : await fromUrl(imageSource, headers))
  } catch (e) {
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

export const getSlideImagesInPyramid = async (imagePyramid) => {
  // Get all images in the pyramid corresponding to the whole slide image. Filter out any meta-images or those with transparent masks.

  if (typeof (imagePyramid?.ifdRequests) !== 'object') {
    throw new Error("Malformed image pyramid. Please retry pyramid creation using the `getImagePyramid()` method.")
  }

  const allImages = await getAllImagesInPyramid(imagePyramid)

  const aspectRatioTolerance = 0.01
  const validImageSets = allImages
    .filter(image => image.fileDirectory.photometricInterpretation !== globals.photometricInterpretations.TransparencyMask)
    .sort((image1, image2) => image2.getWidth() - image1.getWidth())
    .reduce((sets, image) => {
      const aspectRatio = image.getWidth() / image.getHeight()
      const aspectRatioSetIndex = sets.findIndex(set => Math.abs(set[0].getWidth() / set[0].getHeight() - aspectRatio) < aspectRatioTolerance)
      if (aspectRatioSetIndex !== -1) {
        sets[aspectRatioSetIndex].push(image)
      } else {
        sets.push([image])
      }
      return sets
    }, [])

  const bestSet = validImageSets.reduce((largestSet, set) => {
    if (largestSet.length < set.length || (largestSet.length === set.length && largestSet[0].getWidth() < set[0].getWidth())) {
      largestSet = set
    }
    return largestSet
  }, [])

  return bestSet

}

export const getImageInfo = async (imagePyramid) => {
  // Get basic information about the image (width, height, MPP for now)

  if (typeof (imagePyramid?.ifdRequests) !== 'object') {
    throw new Error("Malformed image pyramid. Please retry pyramid creation using the `getImagePyramid()` method.")
  }
  
  const slideImages = await getSlideImagesInPyramid(imagePyramid)
  const largestImage = slideImages[0]
  
  let pixelsPerMeter = undefined
  if (largestImage?.fileDirectory?.ImageDescription && largestImage.fileDirectory.ImageDescription.includes("MPP")) {
    const micronsPerPixel = largestImage.fileDirectory.ImageDescription.split("|").find(s => s.includes("MPP")).split("=")[1].trim()
    pixelsPerMeter = 1 / (parseFloat(micronsPerPixel) * Math.pow(10, -6))
  }

  const response = new Response(
    JSON.stringify({
      'width': largestImage.getWidth(),
      'height': largestImage.getHeight(),
      pixelsPerMeter
    }), { status: 200 }
  )

  return response
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

export const getImageTile = async (imagePyramid, tileParams, pool) => {
  // Get individual tiles from the appropriate image in the pyramid.

  if (typeof (imagePyramid?.ifdRequests) !== 'object') {
    throw new Error("Malformed image pyramid. Please retry pyramid creation using the `getImagePyramid()` method.")
  }

  const parsedTileParams = utils.parseTileParams(tileParams)
  const { tileX, tileY, tileWidth, tileHeight, tileSize } = parsedTileParams

  if (!Number.isInteger(tileX) || !Number.isInteger(tileY) || !Number.isInteger(tileWidth) || !Number.isInteger(tileHeight) || !Number.isInteger(tileSize)) {
    console.error("Tile Request missing critical parameters!", tileX, tileY, tileWidth, tileHeight, tileSize)
    return
  }

  const optimalImageInTiff = await utils.getImageByRatio(imagePyramid, tileWidth, tileSize)

  const optimalImageWidth = optimalImageInTiff.getWidth()
  const optimalImageHeight = optimalImageInTiff.getHeight()
  
  let tileWidthToRender, tileHeightToRender
  if (tileWidth > tileHeight) {
    tileHeightToRender = Math.floor(tileHeight * tileSize / tileWidth)
    tileWidthToRender = tileSize
  } else {
    tileWidthToRender = Math.floor(tileWidth * tileSize/tileHeight)
    tileHeightToRender = tileSize
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

  const data = await optimalImageInTiff.readRasters(geotiffParameters)

  const imageResponse = await utils.convertToImageBlob(data, tileWidthToRender, tileHeightToRender, optimalImageInTiff.fileDirectory)
  return imageResponse
}

export const createPool = async (tiffImage, numWorkers = 0, supportedDecoders) => {
  let workerPool = undefined
  if (typeof (Worker) !== 'undefined' && Number.isInteger(numWorkers) && numWorkers > 0) {

    if (!supportedDecoders) {
      supportedDecoders = await setupDecoders()
    }
    // Condition to check if this is a service worker-like environment. Service workers cannot create new workers, 
    // plus the GeoTIFF version has to be downgraded to avoid any dynamic imports.
    // As a result, thread creation and non-standard image decoding does not work inside service workers. You would typically 
    // only use service workers to support OpenSeadragon anyway, in which case you'd be better off using something like
    // https://github.com/episphere/GeoTIFFTileSource-JPEG2k .

    const imageCompression = tiffImage?.fileDirectory.Compression
    let createWorker

    try {
      await getDecoder(tiffImage.fileDirectory)
    } catch (e) {
      if (e.message.includes("Unknown compression method")) {
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
    }

    workerPool = new Pool(Math.min(Math.floor(navigator.hardwareConcurrency / 2), numWorkers), createWorker)
    workerPool.supportedCompression = imageCompression

    await new Promise(res => setTimeout(res, 500)) // Setting up the worker pool is an asynchronous task, give it time to complete before moving on.
  }
  return workerPool
}

export const destroyPool = (workerPool) => {
  workerPool?.destroy()
  workerPool = undefined
  return workerPool
}

export default Imagebox3