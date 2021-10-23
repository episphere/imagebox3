importScripts(`https://episphere.github.io/imageBox3/imageBox3.js`)

self.oninstall = () => {
  self.skipWaiting()
}

self.onactivate = () => {
  self.clients.claim()
}

// importScripts(`./imageBox3.js?tileServerPath=iiif`)
