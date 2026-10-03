// Maps the bare 'three' specifier (via import map) onto the page's global r128 build so
// examples/jsm modules such as KTX2Loader share the same THREE instance as GLTFLoader.
const T = window.THREE;
export default T;
export const CompressedTexture = T.CompressedTexture;
export const CompressedTextureLoader = T.CompressedTextureLoader;
export const FileLoader = T.FileLoader;
export const LinearEncoding = T.LinearEncoding;
export const sRGBEncoding = T.sRGBEncoding;
export const LinearFilter = T.LinearFilter;
export const LinearMipmapLinearFilter = T.LinearMipmapLinearFilter;
export const Loader = T.Loader;
export const RGBAFormat = T.RGBAFormat;
export const RGBA_ASTC_4x4_Format = T.RGBA_ASTC_4x4_Format;
export const RGBA_BPTC_Format = T.RGBA_BPTC_Format;
export const RGBA_ETC2_EAC_Format = T.RGBA_ETC2_EAC_Format;
export const RGBA_PVRTC_4BPPV1_Format = T.RGBA_PVRTC_4BPPV1_Format;
export const RGBA_S3TC_DXT5_Format = T.RGBA_S3TC_DXT5_Format;
export const RGB_ETC1_Format = T.RGB_ETC1_Format;
export const RGB_ETC2_Format = T.RGB_ETC2_Format;
export const RGB_PVRTC_4BPPV1_Format = T.RGB_PVRTC_4BPPV1_Format;
export const RGB_S3TC_DXT1_Format = T.RGB_S3TC_DXT1_Format;
export const UnsignedByteType = T.UnsignedByteType;
