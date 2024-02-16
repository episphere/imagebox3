importScripts("https://cdn.jsdelivr.net/npm/@cornerstonejs/codec-openjpeg@1.2.3/dist/openjpegwasm.js");
importScripts("https://cdn.jsdelivr.net/npm/geotiff@2.0.7");

let decoder = {}
OpenJPEGWASM({ 'locateFile': (path, scriptDirectory) => "https://cdn.jsdelivr.net/npm/@cornerstonejs/codec-openjpeg@1.2.3/dist/" + path }).then(openjpegWASM => {
    decoder = new openjpegWASM.J2KDecoder();
})

GeoTIFF.addDecoder([33003, 33005], async () =>
    class JPEG2000Decoder extends GeoTIFF.BaseDecoder {
        constructor(fileDirectory) {
            super();
        }
        decodeBlock(b) {
            let encodedBuffer = decoder.getEncodedBuffer(b.byteLength);
            encodedBuffer.set(new Uint8Array(b));
            decoder.decode();
            let decodedBuffer = decoder.getDecodedBuffer();
            return decodedBuffer.buffer;
        }
    }
);

self.addEventListener('message', async (e) => {
    const { id, fileDirectory, buffer } = e.data;
    const decoder = await GeoTIFF.getDecoder(fileDirectory);
    const decoded = await decoder.decode(fileDirectory, buffer);
    // console.log(decoded)
    self.postMessage({ decoded, id }, [decoded]);
});