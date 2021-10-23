const GEOTIFF_LIB_URL = "https://cdn.jsdelivr.net/npm/geotiff@1.0.4/dist-browser/geotiff.js"

const ENVIRONMENT_IS_WEB = typeof window === "object" && self instanceof Window,
ENVIRONMENT_IS_NODE = !ENVIRONMENT_IS_WEB && typeof process === "object" ,
ENVIRONMENT_IS_WEB_WORKER = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && typeof WorkerGlobalScope === "function" && self instanceof WorkerGlobalScope,
ENVIRONMENT_IS_SERVICE_WORKER = ENVIRONMENT_IS_WEB_WORKER && typeof ServiceWorkerGlobalScope === "function" && self instanceof ServiceWorkerGlobalScope

if (ENVIRONMENT_IS_WEB_WORKER) {
  importScripts(GEOTIFF_LIB_URL)
  importScripts(`https://episphere.github.io/imageBox3/tileServer.js`)
}
else {
  const GeoTIFFScript = document.createElement("script")
  GeoTIFFScript.src = GEOTIFF_LIB_URL
  const tileServerScript = document.createElement("script")
  tileServerScript.src = `https://episphere.github.io/imageBox3/tileServer.js`
  document.head.appendChild(GeoTIFFScript)
  document.head.appendChild(tileServerScript)
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
    }),

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

// let pool = new GeoTIFF.Pool(Math.floor(navigator.hardwareConcurrency/2))

if (ENVIRONMENT_IS_SERVICE_WORKER) {

  self.tileServerBasePath = utils.loadTileServerURL()
  self.addEventListener("fetch", (e) => {
    if (e.request.url.startsWith(self.tileServerBasePath)) {
      let regex = new RegExp(self.tileServerBasePath + "\/(?<identifier>.[^/]*)\/")
      const { identifier } = regex.exec(e.request.url).groups
    
      if (e.request.url.endsWith("/info.json")) {
        e.respondWith(getImageInfo(decodeURIComponent(identifier)))
        return
      }
      
      else if (e.request.url.includes("/full/")) {
        regex = /full\/(?<thumbnailWidthToRender>[0-9]+?),[0-9]*?\/(?<thumbnailRotation>[0-9]+?)\//
        const thumnbnailParams = regex.exec(e.request.url).groups
        e.respondWith(getImageThumbnail(decodeURIComponent(identifier), thumnbnailParams))
        return
      }
      
      else if (e.request.url.endsWith("/default.jpg")) {
        regex = /\/(?<tileTopX>[0-9]+?),(?<tileTopY>[0-9]+?),(?<tileWidth>[0-9]+?),(?<tileHeight>[0-9]+?)\/(?<tileWidthToRender>[0-9]+?),[0-9]*?\/(?<tileRotation>[0-9]+?)\//
        const tileParams = regex.exec(e.request.url).groups
        e.respondWith(getImageTile(decodeURIComponent(identifier), tileParams))
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
