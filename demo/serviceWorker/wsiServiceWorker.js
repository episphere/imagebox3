const tileServerPathSuffix = "iiif"
const tileServerBasePath = `${location.origin}/${tileServerPathSuffix}`
importScripts(`${location.origin}/imageBox3.js`)

self.oninstall = () => {
  self.skipWaiting()
}

self.onactivate = () => {
  self.clients.claim()
}

// importScripts(`./imageBox3.js?tileServerPath=iiif`)