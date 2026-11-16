// Minimal types for word-extractor 1.0.4 (the package ships none).
declare module "word-extractor" {
	interface WordDocument {
		getBody(options?: { filterUnicode?: boolean }): string;
		getFootnotes(options?: { filterUnicode?: boolean }): string;
		getEndnotes(options?: { filterUnicode?: boolean }): string;
		getHeaders(options?: { includeFooters?: boolean; filterUnicode?: boolean }): string;
		getTextboxes(options?: { includeHeadersAndFooters?: boolean; includeBody?: boolean; filterUnicode?: boolean }): string;
	}
	export default class WordExtractor {
		extract(source: string | Buffer): Promise<WordDocument>;
	}
}
