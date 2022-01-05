/* Setup the library: determine execution environment,
 * correspondingly import dependencies (GeoTIFF.js)
 */

import { fromUrl } from "https://cdn.skypack.dev/geotiff"

const imagebox3 = (() => {

  const ENVIRONMENT_IS_WEB = typeof window === "object" && self instanceof Window,
  ENVIRONMENT_IS_NODE = !ENVIRONMENT_IS_WEB && typeof process === "object" ,
  ENVIRONMENT_IS_WEB_WORKER = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && typeof WorkerGlobalScope === "function" && self instanceof WorkerGlobalScope,
  ENVIRONMENT_IS_SERVICE_WORKER = ENVIRONMENT_IS_WEB_WORKER && typeof ServiceWorkerGlobalScope === "function" && self instanceof ServiceWorkerGlobalScope

  let utils = {
    loadTileServerURL: () => {
      // Load tile server base path from search params passed in service worker registration.
      console.log(self.location)
      const urlSearchParams = new URLSearchParams(self.location.search)
      if (urlSearchParams.has("tileServerURL")) {
        return urlSearchParams.get("tileServerURL")
      } else if (urlSearchParams.has("tileServerPathSuffix")) {
        return `${self.location.origin}/${urlSearchParams.get("tileServerPathSuffix")}`
      }
    },

    request: (url, opts) => 
      fetch(url, opts)
      .then(res => {
        if (res.ok) {
          return res
        } else {
          throw Error(res.status)
        }
      })
  }

  // let pool = new Pool(Math.floor(navigator.hardwareConcurrency/2))

  if (ENVIRONMENT_IS_SERVICE_WORKER) {

    self.tileServerBasePath = utils.loadTileServerURL()
    self.addEventListener("fetch", (e) => {
      if (e.request.url.startsWith(self.tileServerBasePath)) {
        let regex = new RegExp(self.tileServerBasePath + "\/(?<identifier>.[^/]*)\/")
        const { identifier } = regex.exec(e.request.url).groups
      
        if (e.request.url.endsWith("/info.json")) {
          e.respondWith(imagebox3.getImageInfo(decodeURIComponent(identifier)))
          return
        }
        
        else if (e.request.url.includes("/full/")) {
          regex = /full\/(?<thumbnailWidthToRender>[0-9]+?),[0-9]*?\/(?<thumbnailRotation>[0-9]+?)\//
          const thumnbnailParams = regex.exec(e.request.url).groups
          e.respondWith(imagebox3.getImageThumbnail(decodeURIComponent(identifier), thumnbnailParams))
          return
        }
        
        else if (e.request.url.endsWith("/default.jpg")) {
          regex = /\/(?<tileX>[0-9]+?),(?<tileY>[0-9]+?),(?<tileWidth>[0-9]+?),(?<tileHeight>[0-9]+?)\/(?<tileSize>[0-9]+?),[0-9]*?\/(?<tileRotation>[0-9]+?)\//
          const tileParams = regex.exec(e.request.url).groups
          e.respondWith(imagebox3.getImageTile(decodeURIComponent(identifier), tileParams))
        }
      
      }
    })

  } else if (ENVIRONMENT_IS_WEB_WORKER) {
    
    self.onmessage = async ({op, data}) => {
      // TODO: Add pooling for workers
    }
    
    
  } else if (ENVIRONMENT_IS_NODE) {
    // TODO: Add node.js support
  }

  return {}

})();

(function ($){

  let tiff = {} // Variable to cache GeoTIFF instance per image for reuse.
  const imageInfoContext = "http://iiif.io/api/image/2/context.json"

  const utils = {
    parseTileParams: (tileParams) => {
      // Parse tile params into tile coordinates and size
      const parsedTileParams = Object.entries(tileParams).reduce((parsed, [key, val]) => {
        if (val) {
          parsed[key] = parseInt(val)
        }
        return parsed
      }, {})

      return parsedTileParams
    },
    
    getImageIndexByRatio: async (tiffPyramid, tileWidthRatio) => {
      // Return the index of the appropriate image in the pyramid for the requested tile
      // by comparing the ratio of the width of the requested tile and the requested resolution, 
      // and comparing it against the ratios of the widths of all images in the pyramid to the largest image.
      // This is a heuristic that is used to determine the best image to use for a given tile request.
      // Could be optimized further.

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
      if (tileWidthRatio > 8) {
        return tiffPyramid.imageWidthRatios.indexOf(sortedRatios[sortedRatios.length - 1])
      }
      // If the requested resolution is less than half the requested tile width, check how many images there are in the pyramid first.
      else if (tileWidthRatio > 2) {
        
        if (sortedRatios.length === 3) {
          return tiffPyramid.imageWidthRatios.indexOf(sortedRatios[sortedRatios.length - 2])
        }
        
        else if (sortedRatios.length > 3) {
          if (tileWidthRatio > 4) {
            return tiffPyramid.imageWidthRatios.indexOf(sortedRatios[sortedRatios.length - 2])
          }
          else {
            return tiffPyramid.imageWidthRatios.indexOf(sortedRatios[sortedRatios.length - 3])
          }
        }
  
      } 
      else {
        return 0 // Return first (i.e., largest) image for high magnification tiles
      }
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
    let pixelsPerMeter
    
    await getImagesInPyramid(imageID, true)
    
    const [width, height] = [tiff[imageID].image.maxWidth, tiff[imageID].image.maxHeight]
    const largestImage = await tiff[imageID].image.getImage(0)
    const micronsPerPixel = largestImage && largestImage.fileDirectory && largestImage.fileDirectory.ImageDescription && largestImage.fileDirectory.ImageDescription.split("|").find(s => s.includes("MPP")).split("=")[1].trim()
    
    if (micronsPerPixel) {
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

  const getImagesInPyramid = async (imageID, firstOnly=false) => {
    tiff[imageID] = tiff[imageID] || {}

    try {
      tiff[imageID].image = tiff[imageID].image || ( await fromUrl(imageID, { cache: false }) )

      const imageCount = await tiff[imageID].image.getImageCount()
      if (tiff[imageID].image.loadedCount !== imageCount) {
        tiff[imageID].image.loadedCount = 0

        const imagePromises = await Promise.allSettled(Array.from(Array(imageCount - 2), (_, ind) => tiff[imageID].image.getImage(ind) ))
        tiff[imageID].image.loadedCount = imagePromises.filter(v => v.status === "fulfilled").length
        if (imagePromises[0].status === "fulfilled") {
          const largestImage = imagePromises[0].value
          const [width, height] = [largestImage.getWidth(), largestImage.getHeight()]
          tiff[imageID].image.maxWidth = width
          tiff[imageID].image.maxHeight = height
        } else {
          tiff[imageID].image.maxWidth = NaN
          tiff[imageID].image.maxHeight = NaN
        }
        
      }
      
    } catch (e) {
      console.error("Couldn't get images", e)  
    }
    return
  }

  

  const getImageThumbnail = async (imageID, tileParams) => {

    const parsedTileParams = utils.parseTileParams(tileParams)

    const { thumbnailWidthToRender } = parsedTileParams
    if (!Number.isInteger(thumbnailWidthToRender)) {
      console.error("Thumbnail Request missing critical parameters!", thumbnailWidthToRender)
      return
    }

    if (!(tiff[imageID] && tiff[imageID].image) || tiff[imageID].image.loadedCount === 0) {
      await getImagesInPyramid(imageID, false)
    }

    const thumbnailImage = await tiff[imageID].image.getImage(1)
    const thumbnailHeightToRender = Math.floor(thumbnailImage.getHeight() * thumbnailWidthToRender / thumbnailImage.getWidth())

    let data = await thumbnailImage.readRasters({
      width: thumbnailWidthToRender,
      height: thumbnailHeightToRender
    })

    const imageResponse = await utils.convertToImageBlob(data, thumbnailWidthToRender, thumbnailHeightToRender)
    return imageResponse
    
  }

  const getImageTile = async (imageID, tileParams) => {
    const parsedTileParams = utils.parseTileParams(tileParams)
    
    const { tileX, tileY, tileWidth, tileHeight, tileSize } = parsedTileParams
    
    if (!Number.isInteger(tileX) || !Number.isInteger(tileY) || !Number.isInteger(tileWidth) || !Number.isInteger(tileHeight) || !Number.isInteger(tileSize)) {
      console.error("Tile Request missing critical parameters!", tileX, tileY, tileWidth, tileHeight, tileSize)
      return
    }

    if (!(tiff[imageID] && tiff[imageID].image) || tiff[imageID].image.loadedCount === 0) {
      await getImagesInPyramid(imageID, false)
    }

    const tileWidthRatio = Math.floor(tileWidth / tileSize)
    const optimalImageIndex = await utils.getImageIndexByRatio(tiff[imageID].image, tileWidthRatio)

    const optimalImageInTiff = await tiff[imageID].image.getImage(optimalImageIndex)
    const optimalImageWidth = optimalImageInTiff.getWidth()
    const optimalImageHeight = optimalImageInTiff.getHeight()
    const tileHeightToRender = Math.floor( tileHeight * tileSize / tileWidth)

    const { maxWidth, maxHeight } = tiff[imageID].image

    const tileInImageLeftCoord = Math.floor( tileX * optimalImageWidth / maxWidth )
    const tileInImageTopCoord = Math.floor( tileY * optimalImageHeight / maxHeight )
    const tileInImageRightCoord = Math.floor( (tileX + tileWidth) * optimalImageWidth / maxWidth )
    const tileInImageBottomCoord = Math.floor( (tileY + tileHeight) * optimalImageHeight / maxHeight )

    const data = await optimalImageInTiff.readRasters({
      width: tileSize,
      height: tileHeightToRender,
      window: [
        tileInImageLeftCoord,
        tileInImageTopCoord,
        tileInImageRightCoord,
        tileInImageBottomCoord,
      ]
    })

    const imageResponse = await utils.convertToImageBlob(data, tileSize, tileHeightToRender)
    return imageResponse
  }
  
  [ getImageInfo, getImageThumbnail, getImageTile ].forEach(method => {
    $[method.name] = method
  })

})(imagebox3)

export default imagebox3