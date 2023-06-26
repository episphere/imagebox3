import imagebox3 from "../../imagebox3.mjs"

const imgBox = {}

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
    if (!previousHashParams["fileURL"]) {
      setTimeout(() => imgBox.loadImage(hashParams["fileURL"]), 2000)
    } else {
      imgBox.loadImage(hashParams["fileURL"])
    }
  }

  if (hashParams.wsiCenterX && hashParams.wsiCenterY && hashParams.wsiZoom) {
    imgBox.handlePanAndZoom(hashParams.wsiCenterX, hashParams.wsiCenterY, hashParams.wsiZoom)
  }

  window.localStorage.hashParams = JSON.stringify(hashParams)
}

imgBox.modifyHashString = (hashObj, removeFromHistory=false) => {
  // hashObj contains hash keys with corresponding values to update..
  let hash = decodeURIComponent(window.location.hash)
  
  Object.entries(hashObj).forEach(([key, val]) => {
    val = encodeURIComponent(val)
    if (val && val !== hashParams[key]) {
     
      if (hashParams[key]) {
        hash = hash.replace(`${key}=${hashParams[key]}`, `${key}=${val}`)
      } 
      else {
        hash += hash.length > 0 ? "&" : ""
        hash += `${key}=${val}`
      }
  
    } 
    
    else if (!val) {
      const param = `${key}=${hashParams[key]}`
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

imgBox.loadTile = async () => {
  const tileElement = document.getElementById("tile")

  const fileURL = document.getElementById("imageURLInput").value
  const tileX = document.getElementById("topX").value
  const tileY = document.getElementById("topY").value
  const tileWidth = document.getElementById("tileW").value
  const tileHeight = document.getElementById("tileH").value
  const tileSize = document.getElementById("imageW").value
  
  tileElement.src = URL.createObjectURL(await (await imagebox3.getImageTile(decodeURIComponent(fileURL), {
    tileX,
    tileY,
    tileWidth,
    tileHeight,
    tileSize
  })).blob())
  tileElement.onload = () => {
    URL.revokeObjectURL(tileElement.src)
  }
}

imgBox.loadImage = async (url="https://storage.googleapis.com/imagebox_test/openslide-testdata/Aperio/CMU-1.svs") => {
  document.getElementById("imageURLInput").value = url
  imgBox.loadTile()
}

imgBox.changeImage = () => {
  const fileURL = document.getElementById("imageURLInput").value
  imgBox.modifyHashString({fileURL}, false)
}


window.onload = async () => {

  loadHashParams()
  
  if (!hashParams["fileURL"]) {
    imgBox.loadImage()
  }

}

window.onhashchange = loadHashParams
window.imgBox = imgBox