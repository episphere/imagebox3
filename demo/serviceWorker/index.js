const tileServerPathSuffix = "iiif"

const imgBox = {}
imgBox.tileServerBasePath = `${window.location.origin}/${tileServerPathSuffix}`

imgBox.default = {
  "tileSourceOptions": {
    "profile": [ "http://iiif.io/api/image/2/level2.json" ],
    "protocol": "http://iiif.io/api/image",
    "tiles": [{
      "scaleFactors": [1, 4, 16, 64, 256, 1024],
      "width": 256,
    }]
  },
  "osdViewerOptions": {
    id: "openseadragon",
    visibilityRatio: 1,
    minZoomImageRatio: 1,
    prefixUrl: "https://episphere.github.io/svs/openseadragon/images/",
    imageLoaderLimit: 5,
    timeout: 180*1000,
    crossOriginPolicy: "Anonymous",
  }
}

imgBox.handlers = {
  viewer: {
    animationFinish: ({eventSource: viewer}) => {
      const center = viewer.viewport.getCenter()
      const zoom = utils.roundToPrecision(viewer.viewport.getZoom(), 3)
  
      if (center.x !== parseFloat(hashParams.wsiCenterX) || center.y !== parseFloat(hashParams.wsiCenterY) || zoom !== parseFloat(hashParams.wsiZoom)) {
        imgBox.modifyHashString({
          'wsiCenterX': center.x,
          'wsiCenterY': center.y,
          'wsiZoom': zoom
        }, true)
      }
    },
    
    open: ({eventSource: viewer}) => {
      viewer.world.getItemAt(0).addOnceHandler('fully-loaded-change', imgBox.handlers.tiledImage.fullyLoadedChange)
    },
  },
  
  tiledImage: {
    fullyLoadedChange: (_) => {
      imgBox.progressBar(false)
      imgBox.handlePanAndZoom()
    }
  }

}

const utils = {
  roundToPrecision: (value, precision) => Math.round((parseFloat(value)  + Number.EPSILON) * 10**precision) / 10**precision
}

var hashParams = {}
localStorage.hashParams = ""

const loadHashParams = async () => {
  // Load hash parameters from the URL.
  const previousHashParams = window.localStorage.hashParams ? JSON.parse(window.localStorage.hashParams) : {}
  hashParams = {}

  if (window.location.hash.includes("=")) {
    
    window.location.hash.slice(1).split('&').forEach( (param) => {
      let [key, value] = param.split('=')
      value = value.replace(/['"]+/g, "") // for when the hash parameter contains quotes.
      value = decodeURIComponent(value)
      hashParams[key] = value
    })
  
  }
  
  if (hashParams["fileURL"] && previousHashParams?.fileURL !== hashParams["fileURL"]) {
    imgBox.progressBar(false)
    imgBox.loadImage(hashParams["fileURL"])
  }

  if (hashParams.wsiCenterX && hashParams.wsiCenterY && hashParams.wsiZoom) {
    imgBox.handlePanAndZoom(hashParams.wsiCenterX, hashParams.wsiCenterY, hashParams.wsiZoom)
  }

  window.localStorage.hashParams = JSON.stringify(hashParams)
}

imgBox.modifyHashString = (hashObj, removeFromHistory=true) => {
  // hashObj contains hash keys with corresponding values to update..
  let hash = window.location.hash + ""
  
  Object.entries(hashObj).forEach(([key, val]) => {
    if (val && val !== hashParams[key]) {
     
      if (hashParams[key]) {
        hash = hash.replace(`${key}=${encodeURIComponent(hashParams[key])}`, `${key}=${encodeURIComponent(val)}`)
      } 
      else {
        hash += hash.length > 0 ? "&" : ""
        hash += `${key}=${encodeURIComponent(val)}`
      }
  
    } 
    
    else if (!val) {
      const param = `${key}=${encodeURIComponent(hashParams[key])}`
      const paramIndex = hash.indexOf(param)
      
      if (hash[paramIndex-1] === "&") {  // if hash is of the form "...&q=123...", remove preceding & as well.
        hash = hash.replace(`&${param}`, "")
      } 
      
      else if (hash[paramIndex + param.length] === "&") { // if hash is of the form "#q=123&...", remove following & as well.
        hash = hash.replace(`${param}&`, "")
      } 
      
      else { // if hash is just #q=123, remove just the param.
        hash = hash.replace(param, "")
      }
    }
  })
  
  window.location.hash = hash

  if (removeFromHistory) {
    history.replaceState({}, '', window.location.pathname + window.location.hash)
  }
}

imgBox.progressBar = (show=true) => {

  if (show) {
    document.getElementById("progressBarContainer").style.opacity = 1
    
    let progressBarCurrentWidth = 0
    let moveAheadBy = 2
    
    imgBox.progressBarMover = setInterval(() => {
      if (progressBarCurrentWidth > 35 && progressBarCurrentWidth < 65) {
        moveAheadBy = 0.75
      } 
      else if (progressBarCurrentWidth >= 65 && progressBarCurrentWidth < 90) {
        moveAheadBy = 0.3
      } 
      else if (progressBarCurrentWidth >= 90 && progressBarCurrentWidth < 95) {
        moveAheadBy = 0.01
      }
      else if (progressBarCurrentWidth >= 95 && progressBarCurrentWidth < 100) {
        moveAheadBy = 0
      }

      progressBarCurrentWidth += moveAheadBy
      progressBarCurrentWidth = progressBarCurrentWidth < 100 ? progressBarCurrentWidth : 100
      
      document.getElementById("progressBar").style.width = `${progressBarCurrentWidth}%`
    }, 200)
  
  } 
  else if (imgBox.progressBarMover) {
    clearInterval(imgBox.progressBarMover)
    delete imgBox.progressBarMover
  
    setTimeout(() => {
      
      setTimeout(() => {
        document.getElementById("progressBar").style.width = "0%"
      }, 700)
      
      document.getElementById("progressBarContainer").style.opacity = "0"
    }, 700)
    
    document.getElementById("progressBar").style.width = "100%"
  }

}

imgBox.createTileSource = async (url) => {
  // Create a tile source for the image.
  const imageURLForSW = `${imgBox.tileServerBasePath}/${encodeURIComponent(url)}`
  const infoURL = `${imageURLForSW}/info.json`

  let imageInfoReq = await fetch(infoURL)
  if (imageInfoReq.status !== 200) {
    //alert("An error occurred retrieving the image information. Please try again later.")
    console.error(`Encountered HTTP ${imageInfoReq.status} while retrieving image information.`)
    
    imgBox.modifyHashString({
      'fileURL': undefined
    })
    
    imgBox.progressBar(false)
    
    return undefined
  }
  
  const imageInfo = await imageInfoReq.json()
  const { width, height } = imageInfo
  const tileSource = {
    ...imgBox.default.tileSourceOptions,
    "@context": imageInfo["@context"],
    "@id": imageURLForSW,
    width,
    height,
  }

  return tileSource
}

imgBox.loadImage = async (url=document.getElementById("imageURLInput").value) => {
  // Load the image.
  if (url !== document.getElementById("imageURLInput").value) {
    document.getElementById("imageURLInput").value = url
  }
  
  if (!imgBox.progressBarMover) {
    imgBox.progressBar(true)
  }

  const tileSource = await imgBox.createTileSource(url)
  if (!tileSource) {
    alert("Error retrieving image information!")
    return undefined
  }
  
  if (!imgBox.viewer) {
    imgBox.viewer = OpenSeadragon(imgBox.default.osdViewerOptions)
    imgBox.viewer.addHandler('animation-finish', imgBox.handlers.viewer.animationFinish)
  }
  else {
    imgBox.viewer.close()
    imgBox.removePanAndZoomFromHash()
  }

  imgBox.viewer.addOnceHandler('open', imgBox.handlers.viewer.open)
  imgBox.viewer.open(tileSource)
}

imgBox.handlePanAndZoom = (centerX=hashParams?.wsiCenterX, centerY=hashParams?.wsiCenterY, zoomLevel=hashParams?.wsiZoom) => {
  if (imgBox.viewer?.viewport) {
    const currentZoom = imgBox.viewer.viewport.getZoom()
    zoomLevel = parseFloat(zoomLevel)
    if (zoomLevel && zoomLevel !== currentZoom) {
      imgBox.viewer.viewport.zoomTo(zoomLevel)
    }
    
    const { x: currentX, y: currentY } = imgBox.viewer.viewport.getCenter()
    centerX = parseFloat(centerX)
    centerY = parseFloat(centerY)
    if (centerX && centerY && ( centerX !== currentX || centerY !== currentY )) {
      imgBox.viewer.viewport.panTo(new OpenSeadragon.Point(centerX, centerY))
    }
  }
}

imgBox.removePanAndZoomFromHash = () => {
  imgBox.modifyHashString({
    'wsiCenterX': undefined,
    'wsiCenterY': undefined,
    'wsiZoom': undefined
  }, true)
}

imgBox.loadDefaultImage = async () => {
  const defaultWSIURL = "https://storage.googleapis.com/imagebox_test/openslide-testdata/Aperio/CMU-1.svs"
  document.getElementById("imageURLInput").value = defaultWSIURL
  imgBox.modifyHashString({
    'fileURL': defaultWSIURL
  })
}

imgBox.changeImage = () => {
  const fileURL = document.getElementById("imageURLInput").value
  imgBox.modifyHashString({
    'fileURL': fileURL
  })
}

imgBox.addServiceWorker = async () => {
	if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(`../../imagebox3.js?tileServerPathSuffix=${tileServerPathSuffix}`, {type: 'classic'})
		.catch((error) => {
      console.log('Service worker registration failed', error)
		})
    await navigator.serviceWorker.ready
	}
}

window.onload = async () => {
  await imgBox.addServiceWorker()
  setTimeout(() => {
    // Give service worker some time to set up. Just a hack.
    // TODO: read up on service workers later and fix.
    loadHashParams()

    if (!hashParams["fileURL"]) {
      setTimeout(() => imgBox.loadDefaultImage(), 1000)
    }
  }, 1000)
}

window.onhashchange = loadHashParams
