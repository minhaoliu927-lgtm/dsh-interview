# Material source snapshot

These MIT sources are maintained copies of 职镜AI's document parser and acquisition modules. `IMPORT_MANIFEST.json` records their original relative paths and source hashes. They are production source, not downloaded runtime code. The plugin rebuilds them with `scripts/vendor-parser.mjs` without reading the old desktop project.

Plugin adaptations: upload limits are 25 MiB; import paths are local; OCR validation uses TypeBox directly and selects an installed user language by default; parser process admission uses the current Host executable; its environment supports Node mode without importing Electron; package discovery identifies `dsh-interview-desk`; user-specific path literals have been removed. The original Windows Job containment, permission arguments, parser capability guard, document validation, pinned DNS transport and OCR bounds remain in place.

PDF.js, saxes, yauzl, parse5 and TypeBox retain their respective third-party licenses. Generated runtime files contain no test fixtures, private files, or external workspace imports. Windows OCR uses installed Windows language support and does not download models.
