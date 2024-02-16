// DO NOT USE THIS FILE IN SERVICE WORKERS. USE imagebox3.js INSTEAD.

import { fromBlob, fromUrl, Pool, getDecoder } from "https://cdn.jsdelivr.net/npm/geotiff@2.1.2/+esm"

const imagebox3 = (() => {

  const ENVIRONMENT_IS_WEB = typeof window === "object" && self instanceof Window,
  ENVIRONMENT_IS_NODE = !ENVIRONMENT_IS_WEB && typeof process === "object" ,
  ENVIRONMENT_IS_WEB_WORKER = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && typeof WorkerGlobalScope === "function" && self instanceof WorkerGlobalScope,
  ENVIRONMENT_IS_SERVICE_WORKER = ENVIRONMENT_IS_WEB_WORKER && typeof ServiceWorkerGlobalScope === "function" && self instanceof ServiceWorkerGlobalScope

  let workerPool = undefined

  let utils = {
    defineTileServerURL: () => {
      // Load tile server base path from search params passed in service worker registration.
      const urlSearchParams = new URLSearchParams(self.location.search)
      if (urlSearchParams.has("tileServerURL")) {
        return urlSearchParams.get("tileServerURL")
      } else if (urlSearchParams.has("tileServerPathSuffix")) {
        return `${self.location.origin}/${urlSearchParams.get("tileServerPathSuffix")}`
      }
    }
  }

  
  if (ENVIRONMENT_IS_SERVICE_WORKER) {
    // Service worker fetch handling.
    self.oninstall = () => {
      self.skipWaiting()
    }
    
    self.onactivate = () => {
      self.clients.claim()
    }

    self.tileServerBasePath = utils.defineTileServerURL()

    self.addEventListener("fetch", (e) => {
      
      if (e.request.url.startsWith(self.tileServerBasePath)) {
        
        let regex = new RegExp(self.tileServerBasePath + "\/(?<identifier>.[^/]*)\/")
        const { identifier } = regex.exec(e.request.url).groups
        
        if (e.request.url.endsWith("/info.json")) {
          e.respondWith(imagebox3.getImageInfo(decodeURIComponent(identifier)))
        }
        
        else if (e.request.url.includes("/full/")) {
          regex = /full\/(?<thumbnailWidthToRender>[0-9]+?),[0-9]*?\/(?<thumbnailRotation>[0-9]+?)\//
          const thumnbnailParams = regex.exec(e.request.url).groups
          e.respondWith(imagebox3.getImageThumbnail(decodeURIComponent(identifier), thumnbnailParams))
        }
        
        else if (e.request.url.endsWith("/default.jpg")) {
          regex = /\/(?<tileX>[0-9]+?),(?<tileY>[0-9]+?),(?<tileWidth>[0-9]+?),(?<tileHeight>[0-9]+?)\/(?<tileSize>[0-9]+?),[0-9]*?\/(?<tileRotation>[0-9]+?)\//
          const tileParams = regex.exec(e.request.url).groups
          e.respondWith(imagebox3.getImageTile(decodeURIComponent(identifier), tileParams))
        }        
      }
 
    })
  } else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WEB_WORKER) {
    // workerPool = new Pool(Math.floor(navigator.hardwareConcurrency/2))
  } else if (ENVIRONMENT_IS_NODE) {
    // TODO: Add node.js support
  }

  return {
    pool: workerPool
  }

})();

(function ($){

  let tiff = {} // Variable to cache GeoTIFF instance per image for reuse.
  const imageInfoContext = "http://iiif.io/api/image/2/context.json"

  const baseURL = import.meta.url.split("/").slice(0,-1).join("/");
  const decodersJSON_URL = `${baseURL}/decoders/decoders.json`;
  
  let supportedDecoders = {};
  fetch(decodersJSON_URL).then(resp => resp.json()).then(decoders => {
      supportedDecoders = decoders
      console.log(supportedDecoders)
  })

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
    
    getImageKeyForCache: (imageID) => {
      let imageKey = imageID
      if (imageID instanceof File) {
        imageKey = imageID.name
      }
      return imageKey
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

  const getImageInfo = async (imageID) => {
    // Get basic information about the image (width, height, MPP)
    let pixelsPerMeter = undefined
    
    const imageKey = utils.getImageKeyForCache(imageID)
    await getImagesInPyramid(imageID, true)
    
    const { maxWidth: width, maxHeight: height} = tiff[imageKey].pyramid
    
    const largestImage = await tiff[imageKey].pyramid.getImage(0)
    if (largestImage?.fileDirectory?.ImageDescription && largestImage.fileDirectory.ImageDescription.includes("MPP")) {
      const micronsPerPixel = largestImage.fileDirectory.ImageDescription.split("|").find(s => s.includes("MPP")).split("=")[1].trim()
      pixelsPerMeter = 1 / (parseFloat(micronsPerPixel) * Math.pow(10, -6))
    }
    
    const response = new Response(
      JSON.stringify({
        width,
        height,
        pixelsPerMeter,
        "@context": imageInfoContext,
      }), { status: 200 }
    )
    
    return response
  }

  const getImagesInPyramid = async (imageID, cache=true) => {
    // Get all images in the pyramid.
    
    const imageKey = utils.getImageKeyForCache(imageID)
    tiff[imageKey] = tiff[imageKey] || {}

    try {
      const headers = cache ? { headers: {'Cache-Control': "no-cache, no-store"}} : {}
      tiff[imageKey].pyramid = tiff[imageKey].pyramid || ( imageID instanceof File ? await fromBlob(imageID) : await fromUrl(imageID, headers) )

      const imageCount = await tiff[imageKey].pyramid.getImageCount()
      if (tiff[imageKey].pyramid.loadedCount !== imageCount) {
        tiff[imageKey].pyramid.loadedCount = 0

        // Optionally, discard the last 2 images since they generally contain slide info and are not useful for tiling.
        const imageRequests = [ ...Array(imageCount) ].map((_, ind) => tiff[imageKey].pyramid.getImage(ind)) 
        const resolvedPromises = await Promise.allSettled(imageRequests)
        tiff[imageKey].pyramid.loadedCount = resolvedPromises.filter(v => v.status === "fulfilled").length
        
        if (resolvedPromises[0].status === "fulfilled") {
          // Note the width and height of the largest image in the pyramid for later ratio calculations.
          const largestImage = resolvedPromises[0].value
          const [width, height] = [largestImage.getWidth(), largestImage.getHeight()]
          tiff[imageKey].pyramid.maxWidth = width
          tiff[imageKey].pyramid.maxHeight = height
        } else {
          tiff[imageKey].pyramid.maxWidth = NaN
          tiff[imageKey].pyramid.maxHeight = NaN
        }
      }
      
    } catch (e) {
      console.error("Couldn't get images", e)
      if (cache) { // Retry in case Cache-Control is not part of Access-Control-Allow-Headers in preflight response
        await getImagesInPyramid(imageID, !cache)
      }
    }
    return
  }

  const getImageThumbnail = async (imageID, tileParams, pool=false) => {
    

    const parsedTileParams = utils.parseTileParams(tileParams)
    let { thumbnailWidthToRender, thumbnailHeightToRender } = parsedTileParams
    
    if (!Number.isInteger(thumbnailWidthToRender) && !Number.isInteger(thumbnailHeightToRender)) {
      console.error("Thumbnail Request missing critical parameters!", thumbnailWidthToRender, thumbnailHeightToRender)
      return
    }

    const imageKey = utils.getImageKeyForCache(imageID)

    if (!(tiff[imageKey] && tiff[imageKey].pyramid) || tiff[imageKey].pyramid.loadedCount === 0) {
      await getImagesInPyramid(imageID, false)
    }

    const thumbnailImage = await tiff[imageKey].pyramid.getImage(1)
    if (pool) {
      await createPool(thumbnailImage)
    }

    if (!thumbnailHeightToRender) {
      thumbnailHeightToRender = Math.floor(thumbnailImage.getHeight() * thumbnailWidthToRender / thumbnailImage.getWidth())
    }
    else if (!thumbnailWidthToRender) {
      thumbnailWidthToRender = Math.floor(thumbnailImage.getWidth() * thumbnailHeightToRender / thumbnailImage.getHeight())
    }

    let data = await thumbnailImage.readRasters({
      width: thumbnailWidthToRender,
      height: thumbnailHeightToRender,
      pool: $.workerPool
    })

    const imageResponse = await utils.convertToImageBlob(data, thumbnailWidthToRender, thumbnailHeightToRender)
    return imageResponse
    
  }

  const getImageTile = async (imageID, tileParams, pool=false) => {
    // Get individual tiles from the appropriate image in the pyramid.

    const parsedTileParams = utils.parseTileParams(tileParams)
    const { tileX, tileY, tileWidth, tileHeight, tileSize } = parsedTileParams
    
    if (!Number.isInteger(tileX) || !Number.isIntegoer(tileY) || !Number.isInteger(tileWidth) || !Number.isInteger(tileHeight) || !Number.isInteger(tileSize)) {
      console.error("Tile Request missing critical parameters!", tileX, tileY, tileWidth, tileHeight, tileSize)
      return
    }

    const imageKey = utils.getImageKeyForCache(imageID)

    if (!(tiff[imageKey] && tiff[imageKey].pyramid) || tiff[imageKey].pyramid.loadedCount === 0) {
      await getImagesInPyramid(imageID, false)
    }

    const optimalImageInTiff = await utils.getImageByRatio(tiff[imageKey].pyramid, tileWidth, tileSize)

    const optimalImageWidth = optimalImageInTiff.getWidth()
    const optimalImageHeight = optimalImageInTiff.getHeight()
    const tileHeightToRender = Math.floor( tileHeight * tileSize / tileWidth)

    if (pool) {
      await createPool(optimalImageInTiff)
    }

    const { maxWidth, maxHeight } = tiff[imageKey].pyramid

    const tileInImageLeftCoord = Math.max(Math.floor(tileX * optimalImageWidth / maxWidth), 0)
    const tileInImageTopCoord = Math.max(Math.floor(tileY * optimalImageHeight / maxHeight), 0)
    const tileInImageRightCoord = Math.min(Math.floor((tileX + tileWidth) * optimalImageWidth / maxWidth), optimalImageWidth)
    const tileInImageBottomCoord = Math.min(Math.floor((tileY + tileHeight) * optimalImageHeight / maxHeight), optimalImageHeight)

    const data = await optimalImageInTiff.readRasters({
      width: tileSize,
      height: tileHeightToRender,
      window: [
        tileInImageLeftCoord,
        tileInImageTopCoord,
        tileInImageRightCoord,
        tileInImageBottomCoord,
      ],
      pool: $.workerPool
    })

    const imageResponse = await utils.convertToImageBlob(data, tileSize, tileHeightToRender)
    return imageResponse
  }
  
  const createPool = async (tiffImage) => {
    if (typeof(Worker) !== 'undefined') {
      // Condition to check if this is a service worker-like environment. Service workers cannot create workers, 
      // plus the GeoTIFF version has to be downgraded to avoid any dynamic imports.
      // As a result, thread creation and non-standard image decoding does not work inside service workers. You would typically 
      // only use service workers to support OpenSeadragon anyway, in which case you'd be better off using something like
      // https://github.com/episphere/GeoTIFFTileSource-JPEG2k .

      const imageCompression = tiffImage?.fileDirectory.Compression
      const geotiffSupportsCompression = typeof(getDecoder(tiffImage.fileDirectory)) === 'function'
      const decoderForCompression = supportedDecoders?.[imageCompression]
      
      let createWorker = undefined
      if (decoderForCompression) {
        createWorker = () => new Worker( URL.createObjectURL( new Blob([`
          importScripts("${baseURL}/decoders/${decoderForCompression}")
        `])));
      }
      
      if (!$.workerPool) {
        $.workerPool = new Pool(Math.min(Math.floor(navigator.hardwareConcurrency/2), 1), createWorker)
        $.workerPool.supportedCompression = imageCompression
      } else if (!geotiffSupportsCompression && $.workerPool.supportedCompression !== imageCompression) {
        destroyPool()
        $.workerPool = new Pool(Math.min(Math.floor(navigator.hardwareConcurrency/2), 1), createWorker)
        $.workerPool.supportedCompression = imageCompression
      }
      
      await new Promise(res => setTimeout(res, 500)) // Setting up the worker pool is an asynchronous task, give it time to complete before moving on.
    }
  }

  const destroyPool = () => {
    $.workerPool?.destroy()
    $.workerPool = undefined
  }
  
  [getImageInfo, getImageThumbnail, getImageTile, createPool, destroyPool].forEach(method => {
    $[method.name] = method
  })

})(imagebox3)

export default imagebox3