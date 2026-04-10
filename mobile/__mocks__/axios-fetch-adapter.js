// Stub the axios fetch adapter in the Jest environment.
// The real adapter probes ReadableStream.cancel() at module load time, which
// crashes against Expo's ReadableStream polyfill. Returning null causes axios
// to skip this adapter and fall back to the http/xhr adapter instead.
export default null;
