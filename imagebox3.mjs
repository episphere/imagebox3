// DO NOT USE THIS FILE IN SERVICE WORKERS. USE imagebox3.js INSTEAD.

import { fromBlob, fromUrl, Pool, getDecoder, globals } from "https://cdn.jsdelivr.net/npm/geotiff@2.1.2/+esm"

class Imagebox3 {
  constructor(imageSource, numWorkers) {
    if (imageSource instanceof File || typeof(imageSource) === 'string') {
      this.imageSource = typeof(imageSource) === 'string' ? decodeURIComponent(imageSource) : imageSource
    } else {
      throw new Error("Unsupported image type for ImageBox3")
    }

    this.tiff = undefined
    this.numWorkers = typeof(numWorkers) === 'number' ? numWorkers : Math.max(Math.floor(navigator.hardwareConcurrency / 2), 1)
    this.workerPool = undefined
    this.supportedDecoders = undefined
  }
  
  async init() {
    this.tiff = await getImagePyramid(this.imageSource, true)
    const imagesInPyramid = await getAllImagesInPyramid(this.tiff.pyramid)
    
    const {width: maxWidth, height: maxHeight} = imagesInPyramid.reduce((largestImageDimensions, image) => {
      if (largestImageDimensions.width < image.getWidth() && largestImageDimensions.height < image.getHeight()) {
        largestImageDimensions.width = image.getWidth()
        largestImageDimensions.height = image.getHeight()
      }
      return largestImageDimensions
    }, {width: 0, height: 0})
    
    this.tiff.pyramid.maxWidth = maxWidth
    this.tiff.pyramid.maxHeight = maxHeight
    
    await this.getSupportedDecoders()
    await this.createWorkerPool(this.numWorkers)
  }

  getImageSource() {
    return this.imageSource
  }

  async changeImageSource(newImageSource) {
    this.imageSource = typeof(newImageSource) === 'string' ? decodeURIComponent(newImageSource) : newImageSource
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
    this.workerPool = await createPool(await this.tiff.pyramid.getImage(0), numWorkers, this.supportedDecoders)
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
    return await getImageInfo(this.tiff.pyramid)
  }

  async getThumbnail(thumbnailWidth=512, thumbnailHeight=512) {
    const tileParams = {
      thumbnailWidthToRender: thumbnailWidth,
      thumbnailHeightToRender: thumbnailHeight
    }
    return await getImageThumbnail(this.tiff.pyramid, tileParams, this.workerPool)
  }

  async getTile(topLeftX, topLeftY, tileWidthInImage, tileHeightInImage, tileSizeToRender) {
    const tileParams = {
      tileX: topLeftX,
      tileY: topLeftY,
      tileWidth: tileWidthInImage,
      tileHeight: tileHeightInImage,
      tileSize: tileSizeToRender
    }
    return await getImageTile(this.tiff.pyramid, tileParams, this.workerPool)
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

  getImageByRatio: async (tiffPyramid, tileWidth, tileWidthToRender) => {
    // Return the index of the appropriate image in the pyramid for the requested tile
    // by comparing the ratio of the width of the requested tile and the requested resolution, 
    // and comparing it against the ratios of the widths of all images in the pyramid to the largest image.
    // This is a heuristic that is used to determine the best image to use for a given tile request.
    // Could be optimized further?

    const tileWidthRatio = Math.floor(tileWidth / tileWidthToRender)
    let bestImageIndex = 0

    if (!tiffPyramid.imageWidthRatios) {
      tiffPyramid.imageWidthRatios = []
    
      for (let imageIndex = 0; imageIndex < tiffPyramid.loadedCount; imageIndex++) {
        const imageWidth = (await tiffPyramid.getImage(imageIndex)).getWidth()
        const maxImageWidth = tiffPyramid.maxWidth
        tiffPyramid.imageWidthRatios.push(maxImageWidth / imageWidth)
      } 
    
    }
    
    const sortedRatios = [...tiffPyramid.imageWidthRatios].sort((a, b) => a - b).slice(0, -1) // Remove thumbnail from consideration

    // If the requested resolution is less than 1/8th the requested tile width, the smallest image should suffice.
    if (tileWidthRatio >= sortedRatios[sortedRatios.length - 1]) {
      bestImageIndex = tiffPyramid.imageWidthRatios.indexOf(sortedRatios[sortedRatios.length - 1])
      
    }
    else if (tileWidthRatio <= sortedRatios[1]) {
      // Return the largest image for high magnification tiles
      bestImageIndex = tiffPyramid.imageWidthRatios.indexOf(sortedRatios[0])
    }
    
    // If the requested resolution is between the highest and lowest resolution images in the pyramid, 
    // return the smallest image with resolution ratio greater than the requested resolution.
    else {
      const otherRatios = sortedRatios.slice(1, sortedRatios.length - 1)
      if (otherRatios.length === 1) {
        bestImageIndex = tiffPyramid.imageWidthRatios.indexOf(otherRatios[0])
      } else {
        otherRatios.forEach((ratio, index) => {
          if (tileWidthRatio >= ratio && tileWidthRatio <= sortedRatios[index + 2]) {
            bestImageIndex = tiffPyramid.imageWidthRatios.indexOf(otherRatios[index])
          }
        })
      }
    }
    return await tiffPyramid.getImage(bestImageIndex)
  },  

  convertToImageBlob: async (data, width, height) => {
    // TODO: Write Node.js module to convert to image

    let imageData = []
    data[0].forEach((val, ind) => {
      imageData.push(val)
      imageData.push(data[1][ind])
      imageData.push(data[2][ind])
      imageData.push(255)
    })

    const cv = new OffscreenCanvas(width, height) // Use OffscreenCanvas so it works in workers as well.
    const ctx = cv.getContext("2d")
    ctx.putImageData( new ImageData(Uint8ClampedArray.from(imageData), width, height), 0, 0 )
    const blob = await cv.convertToBlob({
      type: "image/jpeg",
      quality: 1.0,
    })

    const response = new Response(blob, { status: 200 })
    return response
  }
}

const setupDecoders = async () => {
  const baseURL = import.meta.url.split("/").slice(0,-1).join("/");
  const decodersJSON_URL = `${baseURL}/decoders/decoders.json`;
  return await (await fetch(decodersJSON_URL)).json()
}

export const getImagePyramid = async (imageSource, cache=true) => {
  let tiff = {}
  
  try {
    const headers = cache ? { headers: {'Cache-Control': "no-cache, no-store"}} : {}
    tiff.pyramid = tiff.pyramid || ( imageSource instanceof File ? await fromBlob(imageSource) : await fromUrl(imageSource, headers) )
  }  catch (e) {
    console.error("Couldn't get images", e)
    if (cache) { // Retry in case Cache-Control is not part of Access-Control-Allow-Headers in preflight response
      return await getImagePyramid(imageSource, !cache)
    }
  }
  
  return tiff
}

export const getAllImagesInPyramid = async (imagePyramid) => {
  
  if (typeof(imagePyramid?.ifdRequests) !== 'object') {
    throw new Error("Malformed image pyramid. Please retry pyramid creation using the `getImagePyramid()` method.")
  }
  
  const imageCount = await imagePyramid.getImageCount()
  
  const imageRequests = [ ...Array(imageCount) ].map((_, ind) => imagePyramid.getImage(ind))
  const resolvedPromises = await Promise.allSettled(imageRequests)
  
  const resolvedImages = resolvedPromises.filter((promise) => promise.status === 'fulfilled').map(promise => promise.value)

  return resolvedImages
}

export const getSlideImagesInPyramid = async (imagePyramid) => {
  // Get all images in the pyramid corresponding to the whole slide image. Filter out any meta-images or those with transparent masks.

  if (typeof(imagePyramid?.ifdRequests) !== 'object') {
    throw new Error("Malformed image pyramid. Please retry pyramid creation using the `getImagePyramid()` method.")
  }
  
  const allImages = getAllImagesInPyramid(imagePyramid)
  
  const aspectRatioTolerance = 0.01
  const validImageSets = allImages
    .filter(image => image.fileDirectory.photometricInterpretation !== globals.photometricInterpretation.TransparencyMask)
    .sort((image2, image1) => image2.getWidth() - image1.getWidth())
    .reduce((sets, image) => {
      const aspectRatio = image.getWidth() / image.getHeight()
      const aspectRatioSetIndex = sets.findIndex(set => Math.abs(set[0].getWidth() / set[0].getHeight() - aspectRatio) < aspectRatioTolerance)
      if (aspectRatioSetIndex !== -1) {
        sets[aspectRatioSetIndex].push(image)
      } else {
        sets[sets.length - 1] = [image]
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
  
  if (typeof(imagePyramid?.ifdRequests) !== 'object') {
    throw new Error("Malformed image pyramid. Please retry pyramid creation using the `getImagePyramid()` method.")
  }
  
  const { maxWidth: width, maxHeight: height} = imagePyramid
  let pixelsPerMeter = undefined
  
  const largestImage = await imagePyramid.getImage(0)
  if (largestImage?.fileDirectory?.ImageDescription && largestImage.fileDirectory.ImageDescription.includes("MPP")) {
    const micronsPerPixel = largestImage.fileDirectory.ImageDescription.split("|").find(s => s.includes("MPP")).split("=")[1].trim()
    pixelsPerMeter = 1 / (parseFloat(micronsPerPixel) * Math.pow(10, -6))
  }
  
  const response = new Response(
    JSON.stringify({
      width,
      height,
      pixelsPerMeter
    }), { status: 200 }
  )
  
  return response
}

export const getImageThumbnail = async (imagePyramid, tileParams, pool) => {
  
  if (typeof(imagePyramid?.ifdRequests) !== 'object') {
    throw new Error("Malformed image pyramid. Please retry pyramid creation using the `getImagePyramid()` method.")
  }

  const parsedTileParams = utils.parseTileParams(tileParams)
  let { thumbnailWidthToRender, thumbnailHeightToRender } = parsedTileParams
  
  if (!Number.isInteger(thumbnailWidthToRender) && !Number.isInteger(thumbnailHeightToRender)) {
    console.error("Thumbnail Request missing critical parameters!", thumbnailWidthToRender, thumbnailHeightToRender)
    return
  }

  const thumbnailImage = await imagePyramid.getImage(1)

  if (typeof(thumbnailHeightToRender) !== 'undefined') {
    thumbnailHeightToRender = Math.floor(thumbnailImage.getHeight() * thumbnailWidthToRender / thumbnailImage.getWidth())
  }
  else if (typeof(thumbnailWidthToRender) !== 'undefined') {
    thumbnailWidthToRender = Math.floor(thumbnailImage.getWidth() * thumbnailHeightToRender / thumbnailImage.getHeight())
  }

  const geotiffParameters = {
    width: thumbnailWidthToRender,
    height: thumbnailHeightToRender
  }

  if (pool) {
    geotiffParameters['pool'] = pool
  }

  let data = await thumbnailImage.readRasters(geotiffParameters)

  const imageResponse = await utils.convertToImageBlob(data, thumbnailWidthToRender, thumbnailHeightToRender)
  return imageResponse
  
}

export const getImageTile = async (imagePyramid, tileParams, pool) => {
  // Get individual tiles from the appropriate image in the pyramid.

  if (typeof(imagePyramid?.ifdRequests) !== 'object') {
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
  const tileHeightToRender = Math.floor( tileHeight * tileSize / tileWidth )

  const { maxWidth, maxHeight } = imagePyramid

  const tileInImageLeftCoord = Math.max(Math.floor(tileX * optimalImageWidth / maxWidth), 0)
  const tileInImageTopCoord = Math.max(Math.floor(tileY * optimalImageHeight / maxHeight), 0)
  const tileInImageRightCoord = Math.min(Math.floor((tileX + tileWidth) * optimalImageWidth / maxWidth), optimalImageWidth)
  const tileInImageBottomCoord = Math.min(Math.floor((tileY + tileHeight) * optimalImageHeight / maxHeight), optimalImageHeight)

  const geotiffParameters = {
    width: tileSize,
    height: tileHeightToRender,
    window: [
      tileInImageLeftCoord,
      tileInImageTopCoord,
      tileInImageRightCoord,
      tileInImageBottomCoord,
    ]
  }

  if (pool) {
    geotiffParameters['pool'] = pool
  }

  const data = await optimalImageInTiff.readRasters(geotiffParameters)

  const imageResponse = await utils.convertToImageBlob(data, tileSize, tileHeightToRender)
  return imageResponse
}

export const createPool = async (tiffImage, numWorkers=0, supportedDecoders) => {
  let workerPool = undefined
  if (typeof(Worker) !== 'undefined' && Number.isInteger(numWorkers) && numWorkers > 0) {

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
          const baseURL = import.meta.url.split("/").slice(0,-1).join("/");
          createWorker = () => new Worker( URL.createObjectURL( new Blob([`
            importScripts("${baseURL}/decoders/${decoderForCompression}")
          `])));
        } else {
          throw new Error(`Unsupported compression method: ${imageCompression}. Cannot process this image.`)
        }
      }
    }
    
    workerPool = new Pool(Math.min(Math.floor(navigator.hardwareConcurrency/2), numWorkers), createWorker)
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