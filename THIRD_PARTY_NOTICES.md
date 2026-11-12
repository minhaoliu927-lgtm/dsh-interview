# Third-party notices

The MIT license in `LICENSE` covers original 职镜AI code. It does not replace the licenses of dependencies, adapted third-party code, or the bundled font. This inventory describes `dsh-interview` version `0.1.0-dev.5` and its current package payload.

The README organization was informed by [dsh-Go](https://github.com/ccch1mneyyy/dsh-Go). Its prose, application code, brand artwork and characters are not included; this project's README is independently written.

## Code included in the package

- **DeepSeek Harness, MIT.** The native conversation integration in `client/session.js` and `client/native-chat.jsx` adapts the resource ownership and conversation composition patterns in [`packages/client/ui-subagent/src/client/sidebar-chat/index.tsx`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/client/ui-subagent/src/client/sidebar-chat/index.tsx). The microphone PCM encoding and recording lifecycle in `client/voice/controller.js` were developed with reference to [`client-ui-voice-input/src/client/audio.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/experimental/client-ui-voice-input/src/client/audio.ts). These adaptations compile into `dist/client.js`. DeepSeek's MIT notice is reproduced below. The DSH application and its other packages are supplied by the user's Host; they are not bundled with this plugin.
- **dsh-media-desk, MIT.** The package manifest, Client module build wrapper, native model calls and authenticated route registration were developed with reference to [woniuniuniu/dsh-media-desk at commit `80a16f136cf8b2ea47dc133908b995f427ad963a`](https://github.com/woniuniuniu/dsh-media-desk/tree/80a16f136cf8b2ea47dc133908b995f427ad963a). Its MIT notice is reproduced below. The workbench layout, styles, dictionaries, forms and career workflow are original implementations; the media application itself is not bundled.
- **TypeBox 0.34.49, MIT.** The parser child chunks in `src/materials/runtime/child-chunks` include TypeBox validation code. The build manifest records the actual inputs. TypeBox's MIT notice is reproduced below; its ordinary npm package is also a declared dependency.
- **職镜AI material modules, MIT.** `src/materials/vendor` contains maintained copies of this project's own document parser, source contracts, public URL extraction and Windows OCR workers. `src/materials/vendor/IMPORT_MANIFEST.json` records the source paths and SHA-256 values before adaptation. Its README lists the import, upload-limit, runtime and OCR-language changes. These copies do not depend on the old desktop tree at runtime and do not include restored client assets or old test fonts.

## Font included in the package

The November 2026 interaction review also examined dsh-media-desk 2.7.0 at commit `b72f964e995dad2f7886994accf7bc49edd160cd`, using the user's local REA 6.4.0 analyzer. No REA implementation, recovered application assets, media-desk bundle, or Monid client is included. The new interaction and realtime modules are original code. Native session persistence follows the public API patterns in the fixed DeepSeek Harness source and retains the DeepSeek notice below.

Qwen-Omni-Realtime is an external audio service. This package implements its documented protocol; it does not distribute Qwen SDKs, models, weights or voices, and its MIT license does not license the external service. Service access and usage remain subject to the provider's terms.

`assets/fonts/NotoSansCJKsc-Regular.otf` is the unmodified static Noto Sans CJK SC Regular font distributed by [Noto CJK](https://github.com/notofonts/noto-cjk/tree/main/Sans). It retains **SIL Open Font License 1.1**, not MIT. The complete upstream `Sans/LICENSE` is shipped as `assets/fonts/Noto-CJK-LICENSE.txt`. The font retains its embedded names and copyright metadata. It is used for PDF embedding, is not sold separately, and is not renamed as a modified font. PDF output embeds the full font to preserve glyphs in the current exporter.

| File | Verified SHA-256 |
|---|---|
| `NotoSansCJKsc-Regular.otf` | `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b` |
| `Noto-CJK-LICENSE.txt` | `6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2` |

The fetch script additionally checks fixed upstream Git blob identifiers. The package audit verifies the SHA-256 values above. No font is fetched when users export a document.

## External npm dependencies

The following are declared in `package.json` and locked in `pnpm-lock.yaml`. They are installed separately by the package manager. Their `node_modules` trees, native binaries, bundled subcomponents and license files are **not copied into this plugin's tarball**. Their own distributions retain their notices and license terms. The TypeBox code explicitly described above is the exception that is also included in generated parser chunks.

| Package | Version | Package's declared license | Purpose |
|---|---|---|---|
| `@deepseek-ai/schemastery` | 3.19.0 | MIT | Official DSH plugin settings schema and credential references |
| `ws` | 8.22.1 | MIT | Host-only realtime audio WebSocket transport |
| `@sinclair/typebox` | 0.34.49 | MIT | Source and parser-result validation |
| `pdfjs-dist` | 6.1.200 | Apache-2.0 | PDF text and page coordinate extraction |
| `saxes` | 6.0.0 | ISC | DOCX XML parsing |
| `yauzl` | 3.4.0 | MIT | Bounded DOCX ZIP reading |
| `parse5` | 8.0.0 | MIT | Public webpage parsing |
| `docx` | 9.5.1 | MIT | DOCX export |
| `pdf-lib` | 1.17.1 | MIT | PDF export |
| `@pdf-lib/fontkit` | 1.1.1 | MIT | Font embedding for PDF export |

This table names each direct package's declared license. It does not relicense or flatten the notices of its transitive or bundled components. In particular, PDF.js and its installed resources retain their Apache and component notices, and fonts provided by PDF.js are not the Noto font distributed here. An offline redistribution that adds dependency trees must carry their accompanying licenses and notices as well.

The new schema dependency installs `@deepseek-ai/cosmokit` 1.9.0 and `@standard-schema/spec` 1.1.0, both MIT, with their own license files. Optional ws native peers `bufferutil` and `utf-8-validate` are not installed or bundled by this package.

`esbuild` 0.28.2, `react` 18.3.1 and `react-dom` 18.3.1 are development dependencies under MIT. esbuild and React DOM are not shipped as plugin runtime code. React is external in the Client build and supplied by DSH, preserving the Host's single React instance. Windows OCR calls installed Windows APIs; the plugin does not distribute Windows or a separate OCR model.

## Brand artwork

The original mirror-plane brand symbol in `icon.svg` and the client is covered by this project's MIT license. The wordmarks in `assets/brand/logo-black.svg` and `assets/brand/logo-white.svg` contain outlined glyphs from the Noto Sans CJK SC font documented above. No additional font binary is bundled; the existing SIL Open Font License 1.1 notice is retained.

## DeepSeek Harness license

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## dsh-media-desk license

MIT License

Copyright (c) 2026 woniuniuniu (蜗牛的科技笔记)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## TypeBox license

TypeBox

Json Schema Type Builder with Static Type Resolution for TypeScript

The MIT License (MIT)

Copyright (c) 2017-2026 Haydn Paterson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
