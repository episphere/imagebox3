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
        crossOriginPolicy: "Anonymous",
        zoomPerScroll: 2
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
    roundToPrecision: (value, precision) => Math.round((parseFloat(value) + Number.EPSILON) * 10 ** precision) / 10 ** precision,
    convertToPx: async (value, units) => {
        if (units === "px") {
            return parseInt(value)
        } else {
            const { pixelsPerMicron } = await $.imagebox3Instance.getInfo()
            return Math.round(parseInt(value) * pixelsPerMicron)
        }
    },
    convertToµm: async (value, units) => {
        if (units === "mm") {
            return parseInt(value)
        } else {
            const { pixelsPerMicron } = await $.imagebox3Instance.getInfo()
            return Math.round(parseInt(value) / pixelsPerMicron)
        }
    }
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
        if (typeof (val) !== 'undefined' && val !== $.hashParams[key]) {

            if ($.hashParams[key]) {
                hash = hash.replace(`${key}=${encodeURIComponent($.hashParams[key])}`, `${key}=${encodeURIComponent(val)}`)
            }
            else {
                hash += hash.length > 0 ? "&" : ""
                hash += `${key}=${encodeURIComponent(val)}`
            }

        }

        else if (typeof (val) === 'undefined') {
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

$.progressBar = (show = true, immediate = false) => {

    if (show) {
        document.getElementById("progressBarContainer").classList.remove("opacity-0")
        document.getElementById("progressBarContainer").classList.add("opacity-1")

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
                document.getElementById("progressBar").style.removeProperty("width")
            }, immediate ? 0 : 700)

            document.getElementById("progressBarContainer").classList.remove("opacity-1")
            document.getElementById("progressBarContainer").classList.add("opacity-0")
        }, immediate ? 0 : 700)

        document.getElementById("progressBar").style.width = "100%"
    }

}

$.createTileSource = async (url) => {
    // Create a tile source for the image.
    if (!$.imagebox3Instance) {
        const numWorkers = Math.floor(navigator.hardwareConcurrency / 2)
        $.imagebox3Instance = new Imagebox3(url, numWorkers)
        await $.imagebox3Instance.init()
    }
    else {
        await $.imagebox3Instance.changeImageSource(url)
    }
    console.log(await $.imagebox3Instance.getInfo())
    let tileSources = {}
    try {
        tileSources = await OpenSeadragon.GeoTIFFTileSource.getAllTileSources(url, { logLatency: false, cache: true, slideOnly: true, pool: $.imagebox3Instance.workerPool })
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

$.loadRemoteImage = async (wsiURL, resetPanAndZoom = true, resetTileParams = false) => {
    if ($.imagebox3Instance?.getImageSource() !== wsiURL) {

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
    // $.loadRemoteImage(defaultWSIURL)
}

$.cleanTileParams = (tileX, tileY, tileWidth, tileHeight, tileResolution) => {
    tileWidth = Math.round(tileWidth) || Math.round($.hashParams['tileWidth']) || ($.imagebox3Instance.tiff.maxWidth >= 4096 ? 4096 : $.imagebox3Instance.tiff.maxWidth)
    tileHeight = Math.round(tileHeight) || Math.round($.hashParams['tileHeight']) || ($.imagebox3Instance.tiff.maxWidth >= 4096 ? 4096 : $.imagebox3Instance.tiff.maxWidth)

    tileWidth = tileWidth > 0 && tileWidth <= $.imagebox3Instance.tiff.maxWidth ? tileWidth : ($.imagebox3Instance.tiff.maxWidth >= 4096 ? 4096 : $.imagebox3Instance.tiff.maxWidth)
    tileHeight = tileWidth > 0 && tileHeight <= $.imagebox3Instance.tiff.maxHeight ? tileHeight : ($.imagebox3Instance.tiff.maxWidth >= 4096 ? 4096 : $.imagebox3Instance.tiff.maxWidth)

    tileX = !isNaN(Math.round(tileX)) ? Math.round(tileX) : (!isNaN(Math.round($.hashParams['tileX'])) ? Math.round($.hashParams['tileX']) : Math.floor(($.imagebox3Instance.tiff.maxWidth - tileWidth) / 2))
    tileX = tileX >= 0 ? tileX : 0
    tileX = (tileX + tileWidth <= $.imagebox3Instance.tiff.maxWidth) ? tileX : Math.floor($.imagebox3Instance.tiff.maxWidth - tileWidth)

    tileY = !isNaN(Math.round(tileY)) ? Math.round(tileY) : (!isNaN(Math.round($.hashParams['tileY'])) ? Math.round($.hashParams['tileY']) : Math.floor(($.imagebox3Instance.tiff.maxHeight - tileHeight) / 2))
    tileY = tileY >= 0 ? tileY : 0
    tileY = (tileY + tileHeight <= $.imagebox3Instance.tiff.maxHeight) ? tileY : Math.floor($.imagebox3Instance.tiff.maxHeight - tileHeight)

    tileResolution = Math.round(tileResolution) || Math.round($.hashParams['tileResolution'])
    tileResolution = tileResolution <= Math.max($.imagebox3Instance.tiff.maxWidth, $.imagebox3Instance.tiff.maxHeight) ? tileResolution : 256

    return { tileX, tileY, tileWidth, tileHeight, tileResolution }

}

$.updateTileParams = async (tileX, tileY, tileWidth, tileHeight, tileResolution) => {
    let didUpdateTileParams = false

    tileX = !isNaN(tileX) ? Math.round(tileX) : undefined
    tileY = !isNaN(tileY) ? Math.round(tileY) : undefined
    tileWidth = !isNaN(tileWidth) ? Math.round(tileWidth) : undefined
    tileHeight = !isNaN(tileHeight) ? Math.round(tileHeight) : undefined
    tileResolution = !isNaN(tileResolution) ? Math.round(tileResolution) : undefined

    const unitsSelector = document.getElementById("unitsSelector")

    const tileWidthInputElement = document.getElementById("tileWidth")
    const tileWidthRangeElement = document.getElementById("tileWidthRange")
    if (typeof (tileWidth) !== 'undefined' && tileWidthInputElement.value !== tileWidth) {
        tileWidthInputElement.value = unitsSelector.value === "mm" ? await utils.convertToµm(tileWidth, "px") : tileWidth
        tileWidthRangeElement.value = tileWidthInputElement.value
    }

    const tileHeightInputElement = document.getElementById("tileHeight")
    const tileHeightRangeElement = document.getElementById("tileHeightRange")
    if (typeof (tileHeight) !== 'undefined' && tileHeightInputElement.value !== tileHeight) {
        tileHeightInputElement.value = unitsSelector.value === "mm" ? await utils.convertToµm(tileHeight, "px") : tileHeight
        tileHeightRangeElement.value = tileHeightInputElement.value
    }

    const tileXInputElement = document.getElementById("tileX")
    const tileXRangeElement = document.getElementById("tileXRange")
    if (typeof (tileX) !== 'undefined' && tileXInputElement.value !== tileX) {
        tileXInputElement.value = unitsSelector.value === "mm" ? await utils.convertToµm(tileX, "px") : tileX
        tileXRangeElement.value = tileXInputElement.value
    }

    const tileYInputElement = document.getElementById("tileY")
    const tileYRangeElement = document.getElementById("tileYRange")
    if (typeof (tileY) !== 'undefined' && tileYInputElement.value !== tileY) {
        tileYInputElement.value = unitsSelector.value === "mm" ? await utils.convertToµm(tileY, "px") : tileY
        tileYRangeElement.value = tileYInputElement.value
    }

    const tileResolutionInputElement = document.getElementById("tileResolution")
    if (typeof (tileResolution) !== 'undefined' && tileResolutionInputElement.value !== tileResolution) {
        tileResolutionInputElement.value = tileResolution
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

$.loadTileOverlay = async ({ tileX, tileY, tileWidth, tileHeight, tileResolution }, overlayOnly = false) => {

    if (!$.viewer?.world?.getItemAt(0)?.getFullyLoaded()) {
        document.body.addEventListener("imageFullyLoaded", () => {
            $.loadTileOverlay({ tileX, tileY, tileWidth, tileHeight, tileResolution })
        }, { once: true })
    } else {
        const cleanedTileParams = $.cleanTileParams(tileX, tileY, tileWidth, tileHeight, tileResolution)
        const didUpdateTileParams = await $.updateTileParams(...Object.values(cleanedTileParams))

        if (didUpdateTileParams || $.viewer.currentOverlays.length === 0) {
            const createOverlay = () => {
                const tileOverlay = document.createElement("div")
                tileOverlay.id = "tileOverlay"
                tileOverlay.className = "border border-2 border-dashed border-lime-500 cursor-grab shadow-2xl"

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
                            return Math.round(potentialNewOverlayBounds.x) >= 0 && Math.round(potentialNewOverlayBounds.y) >= 0 && Math.round(potentialNewOverlayBounds.x + potentialNewOverlayBounds.width) <= $.imagebox3Instance.tiff.maxWidth && Math.round(potentialNewOverlayBounds.y + potentialNewOverlayBounds.height) <= $.imagebox3Instance.tiff.maxHeight
                        }

                        if (checkIfInsideBounds()) {
                            overlay.update(overlay.location.plus(deltaViewport));
                            overlay.drawHTML(overlay.element.parentElement, $.viewer.viewport);
                        }
                    },

                    dragEndHandler: () => {
                        const overlay = $.viewer.getOverlayById(tileOverlay);
                        overlay.element.style.cursor = "grab";
                        const { x: tileX, y: tileY, width: tileWidth, height: tileHeight } = $.viewer.world.getItemAt(0).viewportToImageRectangle(overlay.bounds)
                        $.updateTileParams(tileX, tileY, tileWidth, tileHeight, Math.round($.hashParams['tileResolution']))
                        $.loadTile(tileX, tileY, tileWidth, tileHeight, Math.round($.hashParams['tileResolution']))
                    }
                })

            }

            const previousOverlay = $.viewer.currentOverlays[0]

            if (previousOverlay) {
                const previousOverlayLocation = $.viewer.world.getItemAt(0).viewportToImageRectangle(previousOverlay.bounds)

                if (Math.round(previousOverlayLocation.x) !== cleanedTileParams.tileX || Math.round(previousOverlayLocation.y) !== cleanedTileParams.tileY || Math.round(previousOverlayLocation.width) !== cleanedTileParams.tileWidth || Math.round(previousOverlayLocation.height) !== cleanedTileParams.tileHeight || parseInt(previousOverlay.element.getAttribute("data-tileResolution")) !== cleanedTileParams.tileResolution) {
                    previousOverlay.destroy()
                    $.viewer.currentOverlays.shift()
                }
            }

            createOverlay()
            if (!overlayOnly) {
                $.loadTile(...Object.values(cleanedTileParams))
            }

        }
    }
}

$.loadTile = async (tileX, tileY, tileWidth, tileHeight, tileResolution) => {
    const tileElement = document.getElementById("tileImg")

    tileElement.src = URL.createObjectURL(await $.imagebox3Instance.getTile(tileX, tileY, tileWidth, tileHeight, tileResolution))
    tileElement.onload = () => {
        document.getElementById("tileViewer").classList.remove("hidden")

        document.getElementById("tileResolution").value = Math.round(tileElement.getBoundingClientRect().width)
        document.getElementById("tileResCopy").innerText = Math.round(tileElement.getBoundingClientRect().height)

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

    const unitsSelector = document.getElementById("unitsSelector")
    unitsSelector.onchange = async (e) => {
        const { pixelsPerMicron } = await $.imagebox3Instance.getInfo()
        const tileParamsElements = document.body.getElementsByClassName("tileParams")
        if (unitsSelector.value === "px") {
            for (const el of tileParamsElements) {
                const mmValue = parseFloat(el.value)
                el.value = Math.round(mmValue * pixelsPerMicron)
                el.setAttribute("min", Math.round(el.getAttribute("min")) * pixelsPerMicron)
                el.setAttribute("max", Math.round(el.getAttribute("max")) * pixelsPerMicron)
            }
        } else {
            for (const el of tileParamsElements) {
                const pxValue = parseFloat(el.value)
                el.value = Math.round(pxValue / pixelsPerMicron)
                el.setAttribute("min", Math.round(el.getAttribute("min") / pixelsPerMicron))
                el.setAttribute("max", Math.round(el.getAttribute("max") / pixelsPerMicron))
            }
        }
    }

    const tileParamElementIDs = ['tileX', 'tileY', 'tileWidth', 'tileHeight', 'tileResolution']
    const tileParamRangeElementIDs = ['tileXRange', 'tileYRange', 'tileWidthRange', 'tileHeightRange']
    tileParamElementIDs.forEach((elementId, ind) => {
        const tileParamElement = document.getElementById(elementId)
        const tileParamRangeElement = ind < tileParamRangeElementIDs.length ? document.getElementById(tileParamRangeElementIDs[ind]) : undefined

        tileParamElement.onchange = async (e, overlayOnly = false) => {

            if (parseInt(e.target.value) < parseInt(e.target.getAttribute("min"))) {
                e.target.value = e.target.getAttribute("min")
            }
            else if (parseInt(e.target.value) > parseInt(e.target.getAttribute("max"))) {
                e.target.value = e.target.getAttribute("max")
            }

            tileParamElement.value = e.target.value
            if (tileParamRangeElement) {
                tileParamRangeElement.value = tileParamElement.value
            }

            if (elementId === 'tileWidth') {
                const tileX = document.getElementById(tileParamElementIDs[0])
                const tileXRange = document.getElementById(tileParamRangeElementIDs[0])

                const newTileWidthInPx = await utils.convertToPx(tileParamElement.value, unitsSelector.value)

                if (parseInt(tileX.value) + newTileWidthInPx > $.imagebox3Instance.tiff.maxWidth) {
                    tileX.value = unitsSelector.value === "mm" ? await utils.convertToµm($.imagebox3Instance.tiff.maxWidth - newTileWidthInPx) : $.imagebox3Instance.tiff.maxWidth - newTileWidthInPx
                    tileXRange.value = tileX.value
                }

                tileX.setAttribute("max", unitsSelector.value === "mm" ? await utils.convertToµm($.imagebox3Instance.tiff.maxWidth - newTileWidthInPx) : $.imagebox3Instance.tiff.maxWidth - newTileWidthInPx)
                tileXRange.setAttribute("max", unitsSelector.value === "mm" ? await utils.convertToµm($.imagebox3Instance.tiff.maxWidth - newTileWidthInPx) : $.imagebox3Instance.tiff.maxWidth - newTileWidthInPx)
            }
            if (elementId === 'tileHeight') {
                const tileY = document.getElementById(tileParamElementIDs[1])
                const tileYRange = document.getElementById(tileParamRangeElementIDs[1])

                const newTileHeightInPx = await utils.convertToPx(tileParamElement.value, unitsSelector.value)

                if (parseInt(tileY.value) + newTileHeightInPx > $.imagebox3Instance.tiff.maxHeight) {
                    tileY.value = unitsSelector.value === "mm" ? await utils.convertToµm($.imagebox3Instance.tiff.maxHeight - newTileHeightInPx) : $.imagebox3Instance.tiff.maxHeight - newTileHeightInPxx
                    tileYRange.value = tileY.value
                }
                tileY.setAttribute("max", unitsSelector.value === "mm" ? await utils.convertToµm($.imagebox3Instance.tiff.maxHeight - newTileHeightInPx) : $.imagebox3Instance.tiff.maxHeight - newTileHeightInPx)
                tileYRange.setAttribute("max", unitsSelector.value === "mm" ? await utils.convertToµm($.imagebox3Instance.tiff.maxHeight - newTileHeightInPx) : $.imagebox3Instance.tiff.maxHeight - newTileHeightInPx)
            }

            const tileParamsObj = {}
            for (const eID of tileParamElementIDs) {
                tileParamsObj[eID] = await utils.convertToPx(parseInt(document.getElementById(eID).value), unitsSelector.value)
            }
            tileParamsObj['tileResolution'] = parseInt(document.getElementById('tileResolution').value)
            $.loadTileOverlay(tileParamsObj, overlayOnly)

            if (elementId === 'tileResolution') {
                tileParamElement.parentElement.querySelector("#tileResCopy").innerText = tileParamElement.value
            }
        }

        if (tileParamRangeElement) {
            tileParamRangeElement.oninput = (e) => tileParamElement.onchange(e, true)
            // Necessary so that the request for the tile is only fired after the range input is complete, not during the drag itself.
            tileParamRangeElement.onchange = async (e) => {
                const tileParamValues = []
                for (const eID of tileParamRangeElementIDs) {
                    tileParamValues.push(await utils.convertToPx(parseInt(document.getElementById(eID).value), unitsSelector.value))
                }
                tileParamValues.push(parseInt(document.getElementById('tileResolution').value))
                $.loadTile(...tileParamValues)
            }
        }
    });

    document.body.addEventListener("imageFullyLoaded", (e) => {
        const tileX = document.getElementById("tileX")
        const tileXRange = document.getElementById("tileXRange")

        const tileY = document.getElementById("tileY")
        const tileYRange = document.getElementById("tileYRange")

        const tileWidth = document.getElementById("tileWidth")
        const tileWidthRange = document.getElementById("tileWidthRange")

        const tileHeight = document.getElementById("tileHeight")
        const tileHeightRange = document.getElementById("tileHeightRange")

        const tileResolution = document.getElementById("tileResolution")

        const unitsSelector = document.getElementById("unitsSelector")

        let tileXMaxValue = $.imagebox3Instance.tiff.maxWidth - (parseInt(tileWidth.value) || Math.round($.hashParams['tileWidth']) || 2048)
        tileXMaxValue = unitsSelector.value === "mm" ? utils.convertToµm(tileXMaxValue, "px") : tileXMaxValue
        tileX.setAttribute("max", tileXMaxValue)
        tileXRange.setAttribute("max", tileXMaxValue)

        let tileYMaxValue = $.imagebox3Instance.tiff.maxHeight - (parseInt(tileHeight.value) || Math.round($.hashParams['tileHeight']) || 2048)
        tileYMaxValue = unitsSelector.value === "mm" ? utils.convertToµm(tileYMaxValue, "px") : tileYMaxValue
        tileY.setAttribute("max", tileYMaxValue)
        tileYRange.setAttribute("max", tileYMaxValue)

        let tileWidthMaxValue = Math.min($.imagebox3Instance.tiff.maxWidth, 8192)
        tileWidthMaxValue = unitsSelector.value === "mm" ? utils.convertToµm(tileWidthMaxValue, "px") : tileWidthMaxValue
        tileWidth.setAttribute("max", tileWidthMaxValue)
        tileWidthRange.setAttribute("max", tileWidthMaxValue)

        let tileHeightMaxValue = Math.min($.imagebox3Instance.tiff.maxHeight, 8192)
        tileHeightMaxValue = unitsSelector.value === "mm" ? utils.convertToµm(tileHeightMaxValue, "px") : tileHeightMaxValue
        tileHeight.setAttribute("max", tileHeightMaxValue)
        tileHeightRange.setAttribute("max", tileHeightMaxValue)

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
        const resetTileParams = isNaN(deltaHash['tileX']) && isNaN(deltaHash['tileY']) && isNaN(deltaHash['tileWidth']) && isNaN(deltaHash['tileHeight']) && isNaN(deltaHash['tileResolution'])
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