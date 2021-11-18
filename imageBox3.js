/* Setup the library: determine execution environment,
 * correspondingly import dependencies (GeoTIFF.js)
 */
var imageBox3 = (() => {
  const GEOTIFF_LIB_URL = "https://cdn.jsdelivr.net/npm/geotiff@1.0.4/dist-browser/geotiff.js"

  const ENVIRONMENT_IS_WEB = typeof window === "object" && self instanceof Window,
  ENVIRONMENT_IS_NODE = !ENVIRONMENT_IS_WEB && typeof process === "object" ,
  ENVIRONMENT_IS_WEB_WORKER = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && typeof WorkerGlobalScope === "function" && self instanceof WorkerGlobalScope,
  ENVIRONMENT_IS_SERVICE_WORKER = ENVIRONMENT_IS_WEB_WORKER && typeof ServiceWorkerGlobalScope === "function" && self instanceof ServiceWorkerGlobalScope

  if (ENVIRONMENT_IS_WEB_WORKER) {
    importScripts(GEOTIFF_LIB_URL)
    // importScripts(`https://episphere.github.io/imageBox3/tileServer.js`)
  }
  else if (ENVIRONMENT_IS_WEB) {
    const GeoTIFFScript = document.createElement("script")
    GeoTIFFScript.src = GEOTIFF_LIB_URL
    document.head.appendChild(GeoTIFFScript)
  }

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

  // let pool = new GeoTIFF.Pool(Math.floor(navigator.hardwareConcurrency/2))

  if (ENVIRONMENT_IS_SERVICE_WORKER) {

    self.tileServerBasePath = utils.loadTileServerURL()
    self.addEventListener("fetch", (e) => {
      if (e.request.url.startsWith(self.tileServerBasePath)) {
        let regex = new RegExp(self.tileServerBasePath + "\/(?<identifier>.[^/]*)\/")
        const { identifier } = regex.exec(e.request.url).groups
      
        if (e.request.url.endsWith("/info.json")) {
          e.respondWith(imageBox3.getImageInfo(decodeURIComponent(identifier)))
          return
        }
        
        else if (e.request.url.includes("/full/")) {
          regex = /full\/(?<thumbnailWidthToRender>[0-9]+?),[0-9]*?\/(?<thumbnailRotation>[0-9]+?)\//
          const thumnbnailParams = regex.exec(e.request.url).groups
          e.respondWith(imageBox3.getImageThumbnail(decodeURIComponent(identifier), thumnbnailParams))
          return
        }
        
        else if (e.request.url.endsWith("/default.jpg")) {
          regex = /\/(?<tileTopX>[0-9]+?),(?<tileTopY>[0-9]+?),(?<tileWidth>[0-9]+?),(?<tileHeight>[0-9]+?)\/(?<tileWidthToRender>[0-9]+?),[0-9]*?\/(?<tileRotation>[0-9]+?)\//
          const tileParams = regex.exec(e.request.url).groups
          e.respondWith(imageBox3.getImageTile(decodeURIComponent(identifier), tileParams))
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

(function($){
  let tiff = {}
  const imageInfoContext = "http://iiif.io/api/image/2/context.json"

  const utils = {
    parseTileParams: (tileParams) => {
      const parsedTileParams = Object.entries(tileParams).reduce((parsed, [key, val]) => {
        if (val) {
          parsed[key] = parseInt(val)
        }
        return parsed
      }, {})

      return parsedTileParams
    }
  }

  const getImageInfo = async (imageIdentifier) => {
    let pixelsPerMeter
    
    await getImagesInPyramid(imageIdentifier, true)
    
    const [width, height] = [tiff[imageIdentifier].image.maxWidth, tiff[imageIdentifier].image.maxHeight]
    const largestImage = await tiff[imageIdentifier].image.getImage(0)
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

  const getImagesInPyramid = (imageIdentifier, firstOnly=false) => {
    return new Promise(async (resolve, reject) => {
      tiff[imageIdentifier] = tiff[imageIdentifier] || {}

      try {
        tiff[imageIdentifier].image = tiff[imageIdentifier].image || ( await GeoTIFF.fromUrl(imageIdentifier, { cache: false }) )

        const imageCount = await tiff[imageIdentifier].image.getImageCount()
        if (tiff[imageIdentifier].image.loadedCount !== imageCount) {
          tiff[imageIdentifier].image.loadedCount = 0

          const imagePromises = await Promise.allSettled(Array.from(Array(imageCount - 2), (_, ind) => tiff[imageIdentifier].image.getImage(ind) ))
          tiff[imageIdentifier].image.loadedCount = imagePromises.filter(v => v.status === "fulfilled").length
          if (imagePromises[0].status === "fulfilled") {
            const largestImage = imagePromises[0].value
            const [width, height] = [largestImage.getWidth(), largestImage.getHeight()]
            tiff[imageIdentifier].image.maxWidth = width
            tiff[imageIdentifier].image.maxHeight = height
          } else {
            tiff[imageIdentifier].image.maxWidth = NaN
            tiff[imageIdentifier].image.maxHeight = NaN
          }
          
          resolve()
          return
        }
    
      } catch (e) {
        console.log("Couldn't get images", e)
        reject(e)
      }
    })
  }

  const getImageIndexByRatio = async (imageId, tileWidthRatio) => {
    
    if (!tiff[imageId].image.imageWidthRatios) {
      tiff[imageId].image.imageWidthRatios = []
    
      for (let imageIndex = 0; imageIndex < tiff[imageId].image.loadedCount; imageIndex++) {
        const imageWidth = (await tiff[imageId].image.getImage(imageIndex)).getWidth()
        const maxImageWidth = tiff[imageId].image.maxWidth
        tiff[imageId].image.imageWidthRatios.push(maxImageWidth / imageWidth)
      } 
    
    }
    
    const sortedRatios = [...tiff[imageId].image.imageWidthRatios].sort((a, b) => a - b).slice(0, -1) // Remove thumbnail from consideration
    
    if (tileWidthRatio > 8) {
      return tiff[imageId].image.imageWidthRatios.indexOf(sortedRatios[sortedRatios.length - 1])
    }
    
    else if (tileWidthRatio <= 2 && tileWidthRatio > 0) {
      return 0 // Return first image for high magnification tiles
    }
    
    else {
      
      if (sortedRatios.length === 3) {
        return tiff[imageId].image.imageWidthRatios.indexOf(sortedRatios[sortedRatios.length - 2])
      }
      
      else if (sortedRatios.length > 3) {
        if (tileWidthRatio > 4) {
          return tiff[imageId].image.imageWidthRatios.indexOf(sortedRatios[sortedRatios.length - 2])
        }
        else {
          return tiff[imageId].image.imageWidthRatios.indexOf(sortedRatios[sortedRatios.length - 3])
        }
      }

    }
  }

  const getImageThumbnail = async (imageIdentifier, tileParams) => {

    const parsedTileParams = utils.parseTileParams(tileParams)

    const { thumbnailWidthToRender } = parsedTileParams
    if (!Number.isInteger(thumbnailWidthToRender)) {
      console.error("Thumbnail Request missing critical parameters!", thumbnailWidthToRender)
      return
    }

    if (!(tiff[imageIdentifier] && tiff[imageIdentifier].image) || tiff[imageIdentifier].image.loadedCount === 0) {
      await getImagesInPyramid(imageIdentifier, false)
    }

    const thumbnailImage = await tiff[imageIdentifier].image.getImage(1)
    const thumbnailHeightToRender = Math.floor(thumbnailImage.getHeight() * thumbnailWidthToRender / thumbnailImage.getWidth())

    let data = await thumbnailImage.readRasters({
      width: thumbnailWidthToRender,
      height: thumbnailHeightToRender
    })

    const imageResponse = await convertToImage(data, thumbnailWidthToRender, thumbnailHeightToRender)
    return imageResponse
    
  }

  const getImageTile = async (imageIdentifier, tileParams) => {
    const parsedTileParams = utils.parseTileParams(tileParams)
    
    const { tileTopX, tileTopY, tileWidth, tileHeight, tileWidthToRender } = parsedTileParams
    
    if (!Number.isInteger(tileTopX) || !Number.isInteger(tileTopY) || !Number.isInteger(tileWidth) || !Number.isInteger(tileHeight) || !Number.isInteger(tileWidthToRender)) {
      console.error("Tile Request missing critical parameters!", tileTopX, tileTopY, tileWidth, tileHeight, tileWidthToRender)
      return
    }

    if (!(tiff[imageIdentifier] && tiff[imageIdentifier].image) || tiff[imageIdentifier].image.loadedCount === 0) {
      await getImagesInPyramid(imageIdentifier, false)
    }

    const tileWidthRatio = Math.floor(tileWidth / tileWidthToRender)
    const optimalImageIndex = await getImageIndexByRatio(imageIdentifier, tileWidthRatio)

    const optimalImageInTiff = await tiff[imageIdentifier].image.getImage(optimalImageIndex)
    const optimalImageWidth = optimalImageInTiff.getWidth()
    const optimalImageHeight = optimalImageInTiff.getHeight()
    const tileHeightToRender = Math.floor( tileHeight * tileWidthToRender / tileWidth)

    const { maxWidth, maxHeight } = tiff[imageIdentifier].image

    const tileInImageLeftCoord = Math.floor( tileTopX * optimalImageWidth / maxWidth )
    const tileInImageTopCoord = Math.floor( tileTopY * optimalImageHeight / maxHeight )
    const tileInImageRightCoord = Math.floor( (tileTopX + tileWidth) * optimalImageWidth / maxWidth )
    const tileInImageBottomCoord = Math.floor( (tileTopY + tileHeight) * optimalImageHeight / maxHeight )

    const data = await optimalImageInTiff.readRasters({
      width: tileWidthToRender,
      height: tileHeightToRender,
      window: [
        tileInImageLeftCoord,
        tileInImageTopCoord,
        tileInImageRightCoord,
        tileInImageBottomCoord,
      ]
    })

    const imageResponse = await convertToImage(data, tileWidthToRender, tileHeightToRender)
    return imageResponse
  }

  const convertToImage = async (data, width, height) => {
    let imageData = []
    data[0].forEach((val, ind) => {
      imageData.push(val)
      imageData.push(data[1][ind])
      imageData.push(data[2][ind])
      imageData.push(255)
    })

    const cv = new OffscreenCanvas(width, height)
    const ctx = cv.getContext("2d")
    ctx.putImageData( new ImageData(Uint8ClampedArray.from(imageData), width, height), 0, 0 )
    const blob = await cv.convertToBlob({
      type: "image/jpeg",
      quality: 1.0,
    })

    const response = new Response(blob, { status: 200 })
    return response
  }
  
  [ getImageInfo, getImageThumbnail, getImageTile ].forEach(method => {
    $[method.name] = method
  })

})(imageBox3)