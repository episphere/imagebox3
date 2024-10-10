# ImageBox3
A JavaScript library for zero-footprint, in-browser patch extraction from TIFF-based Whole Slide Imaging (WSI) data. No (server-side) tiling service needed! 
All computation is performed on your device using HTTP Range Requests to retrieve remote patches without downloading the entire image. This ensures complete user governance while operating public and private images alike at zero cost.
ImageBox3 is freely usable and immediately portable to any device with a web browser. Try it with your own whole slide imaging data at: [https://episphere.github.io/imagebox3](https://episphere.github.io/imagebox3).


## Example Usage
Here is how you would retrieve a patch/tile at a specific location in a whole slide image using Imagebox3:

```js
import { Imagebox3 } from "https://episphere.github.io/imagebox3/imagebox3.mjs"

// Create an instance with the URL to the image (or a File object for a local image).
const wholeSlide = new Imagebox3("https://storage.googleapis.com/imagebox_test/openslide-testdata/Aperio/CMU-1.svs")
// Initialize the instance, i.e., retrieve relevant metadata from the file headers.
await wholeSlide.init()

// Get basic image info, such as the width, height and pixelsPerMicron.
const { width: imageWidth, height: imageHeight, pixelsPerMicron } = await wholeSlide.getInfo()

// Fetch patch by passing in parameters corresponding to the coordinates of the top left corner of the patch and its width
// and height in image pixel coordinates, along with the resolution at which it should be returned.
let patchWidth = 512
let patchHeight = 512
let patchTopLeftX = Math.round( (imageWidth - patchWidth) / 2) 
let patchTopLeftY = Math.round( (imageHeight - patchHeight) / 2)
let patchResolution = 512

const patchBlob = await wholeSlide.getTile(patchTopLeftX, patchTopLeftY, patchWidth, patchHeight, patchResolution)

// Render the retrieved PNG blob as an image on a webpage.
const patchObjectURL = URL.createObjectURL(patchBlob)

const img = new Image()
img.src = patchObjectURL
img.onload = () => {
    URL.revokeObjectURL(img.src)
}
```