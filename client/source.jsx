import React from 'react';
import { Button, Modal } from './components.jsx';
import { quoteSegments } from './model.js';

export function SourceDialog({ data, t, onClose, loadOriginal, onDownload }) {
  const [selected, setSelected] = React.useState(0);
  const [limit, setLimit] = React.useState(100);
  const [imageUrl, setImageUrl] = React.useState(null);
  const [imageError, setImageError] = React.useState(false);
  const metadata = data.metadata;
  const blocks = metadata.document?.blocks || metadata.ocr?.lines || [];
  const current = blocks[selected];
  const segments = quoteSegments(metadata.text || '', current ? { quote: current.text, start: current.startOffset, end: current.endOffset } : null);
  const image = ['image/png','image/jpeg'].includes(metadata.original?.mime);
  React.useEffect(() => {
    if (!image) return;
    const controller = new AbortController();
    let url;
    loadOriginal(data.versionId, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(result.blob);
      setImageUrl(url);
    }).catch(error => { if (error.name !== 'AbortError') setImageError(true); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [data.versionId, image, loadOriginal]);
  return <Modal title={`${t('viewSource')} · ${data.title}`} t={t} onClose={onClose}>
    <p className="zj-subtle">{t('sourceReview')}</p><div className="zj-actions">{data.source.originalFileId && <Button small onClick={() => onDownload(data.versionId)}>{t('downloadOriginal')}</Button>}
      {data.source.sourceUrl && <a className="zj-source-link" href={data.source.sourceUrl} target="_blank" rel="noreferrer">{data.source.pageTitle || t('source')}</a>}
    </div>
    {imageError && <p className="zj-error">{t('sourceUnavailable')}</p>}
    {imageUrl && <div className="zj-original-image"><img src={imageUrl} alt={t('originalImage')}/>{current?.box && metadata.ocr && <svg viewBox={`0 0 ${metadata.ocr.width} ${metadata.ocr.height}`} preserveAspectRatio="none" aria-hidden="true"><rect x={current.box.x} y={current.box.y} width={current.box.width} height={current.box.height}/></svg>}</div>}
    {blocks.length > 0 && <div className="zj-source-blocks">{blocks.slice(0,limit).map((block, index) => <button type="button" className={selected === index ? 'is-active' : ''} key={index} onClick={() => setSelected(index)}><span>{block.kind === 'pdf' ? t('page', { number: block.pageNumber }) : t('block', { number: index + 1 })}</span>{block.text}</button>)}{blocks.length > limit && <Button small onClick={() => setLimit(value => value + 100)}>{t('loadMore')}</Button>}</div>}
    <div className="zj-paper-content">{segments.before}{segments.quote && <mark>{segments.quote}</mark>}{segments.after}</div>
    {current && <details className="zj-source-details"><summary>{t('sourceDetails')}</summary><pre>{JSON.stringify({
      ...(current.kind === 'pdf' ? { page: current.pageNumber, bounds: current.bbox } : {}),
      ...(current.kind === 'docx' ? { part: current.sourcePart, path: current.path } : {}),
      ...(current.box ? { bounds: current.box } : {}),
      textRange: [current.startOffset, current.endOffset],
    }, null, 2)}</pre></details>}
  </Modal>;
}
