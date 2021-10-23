let tiff = {}

let utils = {
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
  const micronsPerPixel = largestImage?.fileDirectory?.ImageDescription?.split("|").find(s => s.includes("MPP")).split("=")[1].trim()
  
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

  if (!tiff[imageIdentifier]?.image || tiff[imageIdentifier].image.loadedCount === 0) {
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

  if (!tiff[imageIdentifier]?.image || tiff[imageIdentifier].image.loadedCount === 0) {
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

export {getImageInfo, getImageThumbnail, getImageTile}
