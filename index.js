import Imagebox3 from "./imagebox3.mjs"

const $ = {}
$.hashParams = {}
localStorage.hashParams = ""

$.default = {
    "tileSourceOptions": {
        "profile": ["http://iiif.io/api/image/2/level2.json"],
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
        timeout: 1000 * 1000,
        crossOriginPolicy: "Anonymous"
    }
}

$.handlers = {
    viewer: {
        animationFinish: ({ eventSource: viewer }) => {
            const center = viewer.viewport.getCenter()
            const zoom = utils.roundToPrecision(viewer.viewport.getZoom(), 3)

            if (center.x !== parseFloat($.hashParams['wsiCenterX']) || center.y !== parseFloat($.hashParams['wsiCenterY']) || zoom !== parseFloat($.hashParams['wsiZoom'])) {
                $.modifyHashString({
                    'wsiCenterX': center.x,
                    'wsiCenterY': center.y,
                    'wsiZoom': zoom
                }, true)
            }
        },

        open: ({ eventSource: viewer }) => {
            viewer.world.getItemAt(0).addOnceHandler('fully-loaded-change', $.handlers.tiledImage.fullyLoadedChange)
            viewer.addOnceHandler('tile-load-failed', viewer.close)
        },
    },

    tiledImage: {
        fullyLoadedChange: (_) => {
            $.progressBar(false)
            $.handlePanAndZoom()
            document.body.dispatchEvent(new CustomEvent("imageFullyLoaded"))
        }
    }

}

const utils = {
    roundToPrecision: (value, precision) => Math.round((parseFloat(value) + Number.EPSILON) * 10 ** precision) / 10 ** precision
}

const loadHashParams = () => {
    // Load hash parameters from the URL.
    const previousHashParams = window.localStorage.hashParams ? JSON.parse(window.localStorage.hashParams) : {}
    $.hashParams = {}
    const delta = {}

    if (window.location.hash.includes("=")) {

        window.location.hash.slice(1).split('&').forEach((param) => {
            let [key, value] = param.split('=')
            value = value.replace(/['"]+/g, "") // for when the hash parameter contains quotes.
            value = decodeURIComponent(value)
            $.hashParams[key] = value
        })

    }

    Object.entries($.hashParams).forEach(([key, value]) => {
        if (previousHashParams[key] !== value) {
            delta[key] = value
        }
    })

    window.localStorage.hashParams = JSON.stringify($.hashParams)
    return delta
}

$.modifyHashString = (hashObj, removeFromHistory = true) => {
    // hashObj contains hash keys with corresponding values to update..
    let hash = window.location.hash + ""

    Object.entries(hashObj).forEach(([key, val]) => {
        if (val && val !== $.hashParams[key]) {

            if ($.hashParams[key]) {
                hash = hash.replace(`${key}=${encodeURIComponent($.hashParams[key])}`, `${key}=${encodeURIComponent(val)}`)
            }
            else {
                hash += hash.length > 0 ? "&" : ""
                hash += `${key}=${encodeURIComponent(val)}`
            }

        }

        else if (!val) {
            const param = `${key}=${encodeURIComponent($.hashParams[key])}`
            const paramIndex = hash.indexOf(param)

            if (hash[paramIndex - 1] === "&") {  // if hash is of the form "...&q=123...", remove preceding & as well.
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

$.progressBar = (show = true, immediate=false) => {

    if (show) {
        document.getElementById("progressBarContainer").style.opacity = 1

        let progressBarCurrentWidth = 0
        let moveAheadBy = 2

        $.progressBarMover = setInterval(() => {
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
    else if ($.progressBarMover) {
        clearInterval($.progressBarMover)
        delete $.progressBarMover

        setTimeout(() => {

            setTimeout(() => {
                document.getElementById("progressBar").style.width = "0%"
            }, immediate ? 0 : 700)

            document.getElementById("progressBarContainer").style.opacity = "0"
        }, immediate ? 0 : 700)

        document.getElementById("progressBar").style.width = "100%"
    }

}

$.createTileSource = async (url) => {
    // Create a tile source for the image.
    if (!$.imageBoxInstance) {
        $.imageBoxInstance = new Imagebox3(url, 5)
        await $.imageBoxInstance.init()
    }
    else {
        await $.imageBoxInstance.changeImageSource(url)
    }

    let tileSources = {}
    try {
        tileSources = await OpenSeadragon.GeoTIFFTileSource.getAllTileSources(url, { logLatency: false, cache: true, slideOnly: true, pool: $.imageBoxInstance.workerPool })
    }
    catch (e) {
        console.error(e)
        alert("An error occurred while loading the image. Please check the web browser's Console for more information.")
        $.modifyHashString({
            'wsiURL': undefined
        })

        $.progressBar(false)
        return undefined
    }
    return tileSources
}

$.handlePanAndZoom = (centerX = $.hashParams?.wsiCenterX, centerY = $.hashParams?.wsiCenterY, zoomLevel = $.hashParams?.wsiZoom) => {
    if ($.viewer?.viewport) {
        const currentZoom = $.viewer.viewport.getZoom()
        zoomLevel = parseFloat(zoomLevel)
        if (zoomLevel && zoomLevel !== currentZoom) {
            $.viewer.viewport.zoomTo(zoomLevel)
        }

        const { x: currentX, y: currentY } = $.viewer.viewport.getCenter()
        centerX = parseFloat(centerX)
        centerY = parseFloat(centerY)
        if (centerX && centerY && (centerX !== currentX || centerY !== currentY)) {
            $.viewer.viewport.panTo(new OpenSeadragon.Point(centerX, centerY))
        }
    }
}

$.removePanAndZoomFromHash = () => {
    $.modifyHashString({
        'wsiCenterX': undefined,
        'wsiCenterY': undefined,
        'wsiZoom': undefined
    }, true)
}

$.removeTileParamsFromHash = () => {
    $.modifyHashString({
        'tileX': undefined,
        'tileY': undefined,
        'tileWidth': undefined,
        'tileHeight': undefined,
        'tileResolution': undefined
    }, true)
}

$.loadImage = async (source) => {
    // Load the image.

    if (!$.progressBarMover) {
        $.progressBar(true)
    } else {
        $.progressBar(false)
        setTimeout(() => $.progressBar(true), 500)
    }

    const tileSource = await $.createTileSource(source)
    if (!tileSource) {
        return
    }

    if (!$.viewer) {
        $.viewer = OpenSeadragon($.default.osdViewerOptions)
        $.viewer.addHandler('animation-finish', $.handlers.viewer.animationFinish)
    }
    else {
        $.viewer.close()
    }

    $.viewer.addOnceHandler('open', $.handlers.viewer.open)
    $.viewer.open(tileSource)
}

$.loadRemoteImage = async (wsiURL, resetPanAndZoom = true, resetTileParams=false) => {
    if ($.imageBoxInstance?.getImageSource() !== wsiURL) {

        if (resetPanAndZoom) {
            $.removePanAndZoomFromHash()
        }

        if (resetTileParams) {
            $.removeTileParamsFromHash()
        }

        $.modifyHashString({
            'wsiURL': wsiURL,
            'localFile': undefined
        })
        $.setURLInputValue(wsiURL)
        
        await $.loadImage(wsiURL)
        
        $.loadTileOverlay({
            tileX: $.hashParams['tileX'],
            tileY: $.hashParams['tileY'],
            tileWidth: $.hashParams['tileWidth'],
            tileHeight: $.hashParams['tileHeight'],
            tileResolution: $.hashParams['tileResolution']
        })
    }
    
    document.getElementById("copyTileURL").removeAttribute("disabled")
    document.getElementById("copyTileURL").classList.replace("bg-gray-600", "bg-indigo-600")
    document.getElementById("copyTileURL").classList.add("hover:bg-indigo-500")
    document.getElementById("copyTileURL").classList.add("focus-visible:outline")
    document.getElementById("copyTileURL").classList.add("focus-visible:outline-2")
    document.getElementById("copyTileURL").classList.add("focus-visible:outline-offset-2")
    document.getElementById("copyTileURL").classList.add("focus-visible:outline-indigo-600")
    document.getElementById("copyTileURL").classList.remove("cursor-not-allowed")
}

$.loadLocalImage = async (file) => {
    $.removePanAndZoomFromHash()
    $.modifyHashString({
        'localFile': file.name,
        'wsiURL': undefined
    })
    $.setURLInputValue(undefined)
    
    await $.loadImage(file)
    
    $.loadTileOverlay({
        tileX: $.hashParams['tileX'],
        tileY: $.hashParams['tileY'],
        tileWidth: $.hashParams['tileWidth'],
        tileHeight: $.hashParams['tileHeight'],
        tileResolution: $.hashParams['tileResolution']
    })
    
    document.getElementById("copyTileURL").setAttribute("disabled", true)
    document.getElementById("copyTileURL").classList.replace("bg-indigo-600", "bg-gray-600")
    document.getElementById("copyTileURL").classList.remove("hover:bg-indigo-500")
    document.getElementById("copyTileURL").classList.remove("focus-visible:outline")
    document.getElementById("copyTileURL").classList.remove("focus-visible:outline-2")
    document.getElementById("copyTileURL").classList.remove("focus-visible:outline-offset-2")
    document.getElementById("copyTileURL").classList.remove("focus-visible:outline-indigo-600")
    document.getElementById("copyTileURL").classList.add("cursor-not-allowed")
}
$.loadDefaultImage = async () => {
    const defaultWSIURL = "https://storage.googleapis.com/imagebox_test/openslide-testdata/Aperio/CMU-1.svs"
    $.loadRemoteImage(defaultWSIURL)
}

$.cleanTileParams = (tileX, tileY, tileWidth, tileHeight, tileResolution) => {
    tileX = !Number.isNaN(Math.round(tileX)) ? Math.round(tileX) : (!Number.isNaN(Math.round($.hashParams['tileX'])) ? Math.round($.hashParams['tileX']) : Math.floor(($.imageBoxInstance.tiff.maxWidth - tileWidth) / 2))
    tileY = !Number.isNaN(Math.round(tileY)) ? Math.round(tileY) : (!Number.isNaN(Math.round($.hashParams['tileY'])) ? Math.round($.hashParams['tileY']) : Math.floor(($.imageBoxInstance.tiff.maxWidth - tileWidth) / 2))
    tileWidth = Math.round(tileWidth) || Math.round($.hashParams['tileWidth']) || ($.imageBoxInstance.tiff.maxWidth >= 2048 ? 2048 : $.imageBoxInstance.tiff.maxWidth)
    tileHeight = Math.round(tileHeight) || Math.round($.hashParams['tileHeight']) || ($.imageBoxInstance.tiff.maxWidth >= 2048 ? 2048 : $.imageBoxInstance.tiff.maxWidth)
    
    tileWidth = tileWidth > 0 && tileWidth <= $.imageBoxInstance.tiff.maxWidth ? tileWidth : ($.imageBoxInstance.tiff.maxWidth >= 2048 ? 2048 : $.imageBoxInstance.tiff.maxWidth)
    tileHeight = tileWidth > 0 && tileHeight <= $.imageBoxInstance.tiff.maxHeight ? tileHeight : ($.imageBoxInstance.tiff.maxWidth >= 2048 ? 2048 : $.imageBoxInstance.tiff.maxWidth)

    tileX = tileX >= 0 ? tileX : 0
    tileX = (tileX + tileWidth <= $.imageBoxInstance.tiff.maxWidth) ? tileX : Math.floor($.imageBoxInstance.tiff.maxWidth - tileWidth)

    tileY = tileY >= 0 ? tileY : 0
    tileY = (tileY + tileHeight <= $.imageBoxInstance.tiff.maxHeight) ? tileY : Math.floor($.imageBoxInstance.tiff.maxHeight - tileHeight)

    tileResolution = Math.round(tileResolution) || Math.round($.hashParams['tileResolution'])
    tileResolution = tileResolution <= Math.max($.imageBoxInstance.tiff.maxWidth, $.imageBoxInstance.tiff.maxHeight) ? tileResolution : 256

    return { tileX, tileY, tileWidth, tileHeight, tileResolution }

}

$.updateTileParams = (tileX, tileY, tileWidth, tileHeight, tileResolution) => {
    let didUpdateTileParams = false
    
    tileX = !Number.isNaN(tileX) ? Math.round(tileX) : undefined
    tileY = !Number.isNaN(tileY) ? Math.round(tileY) : undefined
    tileWidth = !Number.isNaN(tileWidth) ? Math.round(tileWidth) : undefined
    tileHeight = !Number.isNaN(tileHeight) ? Math.round(tileHeight) : undefined
    tileResolution = !Number.isNaN(tileResolution) ? Math.round(tileResolution) : undefined

    const tileWidthInputElement = document.getElementById("tileWidth")
    if (typeof(tileWidth) !== 'undefined' && tileWidthInputElement.value !== tileWidth) {
        tileWidthInputElement.value = tileWidth
    }

    const tileHeightInputElement = document.getElementById("tileHeight")
    if (typeof(tileHeight) !== 'undefined' && tileHeightInputElement.value !== tileHeight) {
        tileHeightInputElement.value = tileHeight
    }

    const tileXInputElement = document.getElementById("tileX")
    if (typeof(tileX) !== 'undefined' && tileXInputElement.value !== tileX) {
        tileXInputElement.value = tileX
    }

    const tileYInputElement = document.getElementById("tileY")
    if (typeof(tileY) !== 'undefined' && tileYInputElement.value !== tileY) {
        tileYInputElement.value = tileY
    }

    const tileResolutionInputElement = document.getElementById("tileResolution")
    if (typeof(tileResolution) !== 'undefined' && tileResolutionInputElement.value !== tileResolution) {
        tileResolutionInputElement.value = tileResolution
        tileResolutionInputElement.nextElementSibling.innerText = tileResolution
    }
    
    if (tileWidth !== Math.round($.hashParams['tileWidth']) || tileHeight !== Math.round($.hashParams['tileHeight']) || tileX !== Math.round($.hashParams['tileX']) || tileY !== Math.round($.hashParams['tileY']) || tileResolution !== Math.round($.hashParams['tileResolution'])) {
        didUpdateTileParams = true
        $.modifyHashString({
            tileWidth,
            tileHeight,
            tileX,
            tileY,
            tileResolution
        })
    }
    return didUpdateTileParams
}

$.loadTileOverlay = ({ tileX, tileY, tileWidth, tileHeight, tileResolution }) => {

    const cleanedTileParams = $.cleanTileParams(tileX, tileY, tileWidth, tileHeight, tileResolution)
    const didUpdatetileParams = $.updateTileParams(...Object.values(cleanedTileParams))
    
    if(didUpdatetileParams || $.viewer.currentOverlays.length === 0) {
        const createOverlay = () => {
            const tileOverlay = document.createElement("div")
            tileOverlay.id = "tileOverlay"
            tileOverlay.className = "border border-2 border-dashed border-lime-400 cursor-grab shadow-2xl"
            
            Object.entries(cleanedTileParams).forEach(([key, val]) => {
                tileOverlay.setAttribute(`data-${key}`, val)
            })
    
            const overlayBounds = $.viewer.world.getItemAt(0).imageToViewportRectangle(...Object.values(cleanedTileParams).slice(0, -1))
            
            if ($.viewer.currentOverlays.length > 0) {
                $.viewer.currentOverlays.forEach(overlay => $.viewer.removeOverlay(overlay.element))
            }

            $.viewer.addOverlay({
                element: tileOverlay,
                location: overlayBounds
            })
            
            new OpenSeadragon.MouseTracker({
                element: tileOverlay,
                clickTimeThreshold: 200,
                clickDistThreshold: 50,
                preProcessEventHandler: (e) => {
                    if (e.eventType === "drag" || e.eventType === "dragEnd") {
                        e.stopPropagation = true;
                        e.preventDefault = true;
                    }
                },
                dragHandler: (e) => {
                    const overlay = $.viewer.getOverlayById(tileOverlay);
                    const deltaViewport = $.viewer.viewport.deltaPointsFromPixels(
                        e.delta
                    );
    
                    overlay.element.style.cursor = "grabbing";
                    
                    const checkIfInsideBounds = () => {
                        const potentialNewOverlayLocation = overlay.location.plus(deltaViewport)
                        const potentialNewOverlayBounds = $.viewer.viewport.viewportToImageRectangle(potentialNewOverlayLocation.x, potentialNewOverlayLocation.y, overlay.bounds.width, overlay.bounds.height)
                        return Math.round(potentialNewOverlayBounds.x) >=0 && Math.round(potentialNewOverlayBounds.y) >= 0 && Math.round(potentialNewOverlayBounds.x + potentialNewOverlayBounds.width) <= $.imageBoxInstance.tiff.maxWidth && Math.round(potentialNewOverlayBounds.y + potentialNewOverlayBounds.height) <= $.imageBoxInstance.tiff.maxHeight
                    }
                    
                    if (checkIfInsideBounds()) {
                        overlay.update(overlay.location.plus(deltaViewport));
                        overlay.drawHTML(overlay.element.parentElement, $.viewer.viewport);
                    }
                },
                dragEndHandler: () => {
                    const overlay = $.viewer.getOverlayById(tileOverlay);
                    overlay.element.style.cursor = "grab";
                    const {x: tileX, y: tileY, width: tileWidth, height: tileHeight} = $.viewer.world.getItemAt(0).viewportToImageRectangle(overlay.bounds)
                    $.updateTileParams(tileX, tileY, tileWidth, tileHeight, tileResolution)
                    $.loadTile(tileX, tileY, tileWidth, tileHeight, tileResolution)
                }
            })
            
        }

        const previousOverlay = $.viewer.currentOverlays[0]

        if (previousOverlay) {
            const previousOverlayLocation = $.viewer.world.getItemAt(0).viewportToImageRectangle(previousOverlay.bounds)
        
            if (Math.round(previousOverlayLocation.x) !== tileX || Math.round(previousOverlayLocation.y) !== tileY || Math.round(previousOverlayLocation.width) !== tileWidth || Math.round(previousOverlayLocation.height) !== tileHeight || Math.round(previousOverlay.element.getAttribute("data-tileResolution")) !== tileResolution) {
                previousOverlay.destroy()
                $.viewer.currentOverlays.shift()
            }
        }
        
        if (!$.viewer?.world?.getItemAt(0)?.getFullyLoaded()) {
            document.body.addEventListener("imageFullyLoaded", () => {
                createOverlay()
                $.loadTile(...Object.values(cleanedTileParams))
            }, { once: true })
        }
        else {
            createOverlay()
            $.loadTile(...Object.values(cleanedTileParams))
        }
    }
}

$.loadTile = async (tileX, tileY, tileWidth, tileHeight, tileResolution) => {
    const tileElement = document.getElementById("tileImg")

    tileElement.src = URL.createObjectURL(await (await $.imageBoxInstance.getTile(tileX, tileY, tileWidth, tileHeight, tileResolution)).blob())
    tileElement.onload = () => {
        document.getElementById("tileViewer").classList.remove("hidden")

        document.getElementById("tileResolution").value = tileElement.getBoundingClientRect().width
        document.getElementById("tileResCopy").innerText = tileElement.getBoundingClientRect().height
        
        URL.revokeObjectURL(tileElement.src)
    }
}

$.setURLInputValue = (value) => {
    const wsiURLInput = document.getElementById("wsiURL")
    if (typeof (value) === 'undefined') {
        wsiURLInput.value = ""
    } else if (wsiURLInput.value !== value) {
        wsiURLInput.value = value
    }
}

const setupEventListeners = () => {
    const wsiURLForm = document.getElementById("wsiURLForm")
    wsiURLForm.onsubmit = (e) => {
        e.preventDefault()
        const wsiURLInput = e.target.querySelector("#wsiURL")
        $.loadRemoteImage(wsiURLInput.value)
    }

    const wsiLocalFile = document.getElementById("wsiLocalFile")
    wsiLocalFile.onchange = (e) => {
        $.loadLocalImage(e.target.files[0])
    }

    const demoLinks = document.querySelectorAll(".demoLinks")
    demoLinks.forEach(element => {
        if (!element.hasAttribute("disabled")) {
            element.onclick = (e) => {
                const demoLink = e.target.getAttribute("demoLink")
                if (demoLink !== $.hashParams['wsiURL']) {
                    $.loadRemoteImage(demoLink, true)
                }
            }
        }
    })

    const tileParamElementIDs = ['tileX', 'tileY', 'tileWidth', 'tileHeight', 'tileResolution']
    tileParamElementIDs.forEach(elementId => {
        const tileParamElement = document.getElementById(elementId)
        tileParamElement.onchange = (e) => {
            // console.log()
            if (parseInt(e.target.value) < parseInt(e.target.getAttribute("min"))) {
                e.target.value = e.target.getAttribute("min")
            }
            else if (parseInt(e.target.value) > parseInt(e.target.getAttribute("max"))) {
                e.target.value = e.target.getAttribute("max")
            }
            if (elementId === 'tileWidth') {
                const tileX = document.getElementById(tileParamElementIDs[0])
                if (parseInt(tileX.value) + parseInt(e.target.value) > $.imageBoxInstance.tiff.maxWidth) {
                    tileX.value = $.imageBoxInstance.tiff.maxWidth - parseInt(e.target.value)
                }
                tileX.setAttribute("max", $.imageBoxInstance.tiff.maxWidth - parseInt(e.target.value))
            }
            if (elementId === 'tileHeight') {
                const tileY = document.getElementById(tileParamElementIDs[1])
                if (parseInt(tileY.value) + parseInt(e.target.value) > $.imageBoxInstance.tiff.maxHeight) {
                    tileY.value = $.imageBoxInstance.tiff.maxHeight - parseInt(e.target.value)
                }
                tileY.setAttribute("max", $.imageBoxInstance.tiff.maxHeight - parseInt(e.target.value))
            }
            
            $.loadTileOverlay(tileParamElementIDs.reduce((obj,eID) => {
                obj[eID] = parseInt(document.getElementById(eID).value)
                return obj
            }, {}))
            
            if (elementId === 'tileResolution') {
                tileParamElement.nextElementSibling.innerText = e.target.value
            }
        }
    })

    document.body.addEventListener("imageFullyLoaded", (e) => {
        const tileX = document.getElementById("tileX")
        const tileY = document.getElementById("tileY")
        const tileWidth = document.getElementById("tileWidth")
        const tileHeight = document.getElementById("tileHeight")
        const tileResolution = document.getElementById("tileResolution")

        tileX.setAttribute("max", $.imageBoxInstance.tiff.maxWidth - (parseInt(tileWidth.value) || Math.round($.hashParams['tileWidth']) || 2048))
        tileY.setAttribute("max", $.imageBoxInstance.tiff.maxHeight - (parseInt(tileHeight.value) || Math.round($.hashParams['tileHeight']) || 2048))
        tileWidth.setAttribute("max", $.imageBoxInstance.tiff.maxWidth)
        tileHeight.setAttribute("max", $.imageBoxInstance.tiff.maxHeight)
        tileResolution.setAttribute("max", 2048)
    })
    
    const copyURLBtn = document.getElementById("copyTileURL")
    copyURLBtn.onclick = (e) => {
        navigator.clipboard.writeText(window.location.href);
        e.target.setAttribute("disabled", true)
        e.target.classList.replace("bg-indigo-600", "bg-green-600")
        e.target.classList.replace("hover:bg-indigo-500", "hover:bg-green-600")
        e.target.innerText = "✓ Copied!"
        setTimeout(() => {
            e.target.removeAttribute("disabled")
            e.target.classList.replace("bg-green-600", "bg-indigo-600")
            e.target.classList.replace("hover:bg-green-600", "hover:bg-indigo-500")
            e.target.innerText = "Copy URL"
        }, 1000)
    }

    const downloadTileBtn = document.getElementById("downloadTile")
    downloadTileBtn.onclick = async () => {
        const tileImg = document.getElementById("tileImg")
        if (tileImg.src.length > 0) {
            const a = document.createElement("a")
            const cv = new OffscreenCanvas(tileImg.width, tileImg.height)
            const ctx = cv.getContext('2d')
            ctx.drawImage(tileImg, 0, 0, tileImg.width, tileImg.height)
            a.href = URL.createObjectURL(await cv.convertToBlob({
                type: "image/png"
            }))
            a.download = `ImageBox3 Tile`
            a.click()
        }
    }
}

window.onload = () => {
    setupEventListeners()
    loadHashParams()

    if (!$.hashParams['wsiURL']) {
        $.loadDefaultImage()
    } else {
        // Don't load the URL directly so that the hash parameter can be validated by the input element first. Just in case.
        $.setURLInputValue($.hashParams['wsiURL'])
        const wsiURLForm = document.getElementById("wsiURLForm")
        wsiURLForm.requestSubmit()
    }

}

window.onhashchange = () => {
    const deltaHash = loadHashParams()
    if (deltaHash['wsiURL']) {
        const resetPanAndZoom = isNaN(deltaHash['wsiCenterX']) && isNaN(deltaHash['wsiCenterY']) && isNaN(deltaHash['wsiZoom'])
        const resetTileParams = isNaN(deltaHash['tileX']) && isNaN(deltaHash['tileY']) && isNaN(deltaHash['tileWidth'])  && isNaN(deltaHash['tileHeight'])  && isNaN(deltaHash['tileResolution'])
        $.loadRemoteImage($.hashParams['wsiURL'], resetPanAndZoom, resetTileParams)
    }
    else if (!isNaN(deltaHash['wsiCenterX']) || !isNaN(deltaHash['wsiCenterY']) || !isNaN(deltaHash['wsiZoom'])) {
        $.handlePanAndZoom()
    } else if (!isNaN(deltaHash['tileX']) || !isNaN(deltaHash['tileY']) || !isNaN(deltaHash['tileWidth']) || !isNaN(deltaHash['tileHeight']) || !isNaN(deltaHash['tileResolution'])) {
        $.loadTileOverlay({
            tileX: $.hashParams['tileX'],
            tileY: $.hashParams['tileY'],
            tileWidth: $.hashParams['tileWidth'],
            tileHeight: $.hashParams['tileHeight'],
            tileResolution: $.hashParams['tileRes']
        })
    }

}

export default $