/** Host-only material adapters derived from the project's MIT modules. */
export { ParserSupervisor } from './parser/supervisor/index.ts';
export { DOCUMENT_PARSER_VERSION } from './domain/document-limits.ts';
export { createWindowsOcrWorker } from './acquisition/windows-ocr.ts';
export { checkAcquisitionImage } from './acquisition/image-policy.ts';
export { createHttpJobSource, pinnedJobHttpTransport } from './acquisition/http-job-source.ts';
export { normalizeJobUrl, resolvePublicJobUrl, isPublicJobAddress } from './acquisition/public-url-policy.ts';
export { extractPublicJob } from './acquisition/html-job-extractor.ts';
