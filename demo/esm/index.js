import Imagebox3 from "../../imagebox3.mjs"

const imgBox = {}

var hashParams = {}
localStorage.hashParams = ""

const loadHashParams = async () => {
  // Load hash parameters from the URL.
  // const previousHashParams = window.localStorage.hashParams ? JSON.parse(window.localStorage.hashParams) : {}
  hashParams = {}

  if (window.location.hash.includes("=")) {
    
    window.location.hash.slice(1).split('&').forEach( (param) => {
      let [key, value] = param.split('=')
      value = value.replace(/['"]+/g, "") // for when the hash parameter contains quotes.
      value = decodeURIComponent(value)
      hashParams[key] = value
    })
  
  }
  
  if (hashParams["fileURL"]) {
    imgBox.loadTile(hashParams)
  }

  window.localStorage.hashParams = JSON.stringify(hashParams)
}

imgBox.modifyHashString = (hashObj, removeFromHistory=false) => {
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

imgBox.loadTile = async ({fileURL, tileX, tileY, tileWidth, tileHeight, tileSize}) => {
  const tileElement = document.getElementById("tile")

  const fileURLElement = document.getElementById("imageURLInput")
  if (fileURLElement.value !== fileURL) {
    fileURLElement.value = fileURL
  }
  const tileXElement = document.getElementById("topX")
  if (tileXElement.value !== tileX) {
    tileXElement.value = tileX
  }
  const tileYElement = document.getElementById("topY")
  if (tileYElement.value !== tileY) {
    tileYElement.value = tileY
  }
  const tileWidthElement = document.getElementById("tileW")
  if (tileWidthElement.value !== tileWidth) {
    tileWidthElement.value = tileWidth
  }
  const tileHeightElement = document.getElementById("tileH")
  if (tileHeightElement.value !== tileHeight) {
    tileHeightElement.value = tileHeight
  }
  const tileSizeElement = document.getElementById("imageW")
  if (tileSizeElement.value !== tileSize) {
    tileSizeElement.value = tileSize
  }
  
  if (!imgBox.image) {
    const numWorkers = 4
    imgBox.image = new Imagebox3(decodeURIComponent(fileURL), numWorkers)
    await imgBox.image.init()
  } else if (imgBox.image?.getImageSource() !== decodeURIComponent(fileURL)) {
    await imgBox.image.changeImageSource(fileURL)
  }

  tileElement.src = URL.createObjectURL(await (await imgBox.image.getTile(tileX, tileY, tileWidth, tileHeight, tileSize)).blob())
  tileElement.onload = () => {
    URL.revokeObjectURL(tileElement.src)
  }
}

imgBox.loadImageWithDefaultVals = async (url="https://storage.googleapis.com/imagebox_test/openslide-testdata/Aperio/CMU-1.svs") => {
  const fileURL = document.getElementById("imageURLInput")
  fileURL.value=url
  const tileX = document.getElementById("topX")
  tileX.value="31232"
  const tileY = document.getElementById("topY")
  tileY.value="14336"
  const tileWidth = document.getElementById("tileW")
  tileWidth.value="1024"
  const tileHeight = document.getElementById("tileH")
  tileHeight.value="1024"
  const tileSize = document.getElementById("imageW")
  tileSize.value="256"
  imgBox.modifyHashString({
    'fileURL': fileURL.value,
    'tileX': tileX.value,
    'tileY': tileY.value,
    'tileWidth': tileWidth.value,
    'tileHeight': tileHeight.value,
    'tileSize': tileSize.value,
  })
}


imgBox.setupEventListeners = () => {
  const fileURL = document.getElementById("imageURLInput")
  const submitButton = document.getElementById("imageURLSubmit")
  fileURL.onchange = (e)=> {
    imgBox.modifyHashString({
      'fileURL': e.target.value
    })
  }
  submitButton.onclick = (e)=> {
    imgBox.modifyHashString({
      'fileURL': document.getElementById("imageURLInput").value
    })
  }
  const tileX = document.getElementById("topX")
  tileX.onchange = (e)=> {
    imgBox.modifyHashString({
      'tileX': e.target.value
    })
  }
  const tileY = document.getElementById("topY")
  tileY.onchange = (e)=> {
    imgBox.modifyHashString({
      'tileY': e.target.value
    })
  }
  const tileWidth = document.getElementById("tileW")
  tileWidth.onchange = (e)=> {
    imgBox.modifyHashString({
      'tileWidth': e.target.value
    })
  }
  const tileHeight = document.getElementById("tileH")
  tileHeight.onchange = (e)=> {
    imgBox.modifyHashString({
      'tileHeight': e.target.value
    })
  }
  const tileSize = document.getElementById("imageW")
  tileSize.onchange = (e)=> {
    imgBox.modifyHashString({
      'tileSize': e.target.value
    })
  }
}

window.onload = async () => {

  loadHashParams()
  imgBox.setupEventListeners()

  if (!hashParams["fileURL"]) {
    imgBox.loadImageWithDefaultVals()
  }

}

window.onhashchange = loadHashParams
window.imgBox = imgBox