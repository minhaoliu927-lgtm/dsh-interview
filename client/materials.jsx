import React from 'react';
import { Button, Evaluation } from './components.jsx';
import { latestAssessment, versionEntry } from './model.js';
import { selectedResumePassage } from './analysis.jsx';

export function Materials({ state, t, busy, onAdd, onEdit, onConfirm, onExport, onAssess, selectedId, selectedVersionId, onSelect, onEvidence, onSource, onChatContext }) {
  const [chosenVersion, setChosenVersion] = React.useState(selectedVersionId ?? null);
  const [selection, setSelection] = React.useState(null);
  React.useEffect(() => { setChosenVersion(selectedVersionId ?? null); }, [selectedVersionId, selectedId]);
  const material = state.materials.find(row => row.id === selectedId) || state.materials[0];
  const version = material?.versions.find(row => row.id === chosenVersion) || material?.versions.find(row => row.id === material.latestVersionId) || material?.versions.at(-1);
  const passage = selectedResumePassage(version, selection);
  const rememberSelection = event => setSelection({ versionId: version.id, value: event.currentTarget.value, start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd });
  return <div className="zj-body"><div className="zj-page-heading"><div><h2>{t('personal')}</h2><p>{t('personalNote')}</p></div><Button primary onClick={onAdd}>{t('addMaterial')}</Button></div>
    {!material ? <div className="zj-empty"><h2>{t('noMaterials')}</h2><p>{t('noMaterialsNote')}</p><Button onClick={onAdd}>{t('addMaterial')}</Button></div> : <div className="zj-split">
      <div className="zj-material-list">{state.materials.map(row => <button key={row.id} className={`zj-material-item${row.id === material.id ? ' is-active' : ''}`} onClick={() => { onSelect(row.id); setChosenVersion(null); }}>
        <span className="zj-subtle">{t(row.kind === 'company' ? 'companyMaterial' : row.kind)}</span><strong>{row.title}</strong><span className="zj-subtle">{t('version', { number: row.versions.length })}</span>
      </button>)}</div>
      <div>{version && <><article className="zj-paper"><header className="zj-paper-head"><h3>{material.title}</h3><span className={`zj-tag ${version.confirmed ? 'confirmed' : ''}`}>{t(version.confirmed ? 'confirmed' : 'unconfirmed')}</span>
        <div className="zj-toolbar"><select className="zj-select" value={version.id} aria-label={t('savedVersion')} onChange={e => setChosenVersion(e.target.value)}>{material.versions.map(row => <option key={row.id} value={row.id}>{t('version', { number: row.revision })}</option>)}</select>{version.source?.metadataFileId && <Button small disabled={busy} onClick={() => onSource(version.id)}>{t('viewSource')}</Button>}<Button small onClick={() => onEdit(material, version)}>{t('edit')}</Button></div>
      </header>{!version.confirmed && <div className="zj-review-note"><span>{t('reviewNote')}</span><Button primary small disabled={busy} onClick={() => onConfirm(version.id)}>{t('confirm')}</Button></div>}
        <div className="zj-paper-content">{version.text}</div>
        {onChatContext && <div className="zj-context-actions"><Button small disabled={busy || !version.confirmed} onClick={() => onChatContext(version.id)}>{t('askAboutMaterial')}</Button>
          <details><summary>{t('choosePassage')}</summary><label className="zj-subtle">{t('choosePassageNote')}<textarea readOnly rows={6} value={version.text.replace(/\r\n?/g, '\n')} onSelect={rememberSelection} onKeyUp={rememberSelection} onMouseUp={rememberSelection}/></label>
            <Button small disabled={busy || !version.confirmed || !passage} onClick={() => passage && onChatContext(version.id, passage)}>{t('askAboutPassage')}</Button></details>
        </div>}</article>
        {material.kind === 'resume' && <div className="zj-card"><div className="zj-actions"><Button disabled={busy || !version.confirmed} onClick={() => onAssess(version.id)}>{t('assessResume')}</Button><Button small disabled={busy} onClick={() => onExport('resume', version.id, 'docx')}>{t('exportDocx')}</Button><Button small disabled={busy} onClick={() => onExport('resume', version.id, 'pdf')}>{t('exportPdf')}</Button></div><Evaluation result={latestAssessment(state, version.id)} t={t} onEvidence={onEvidence}/></div>}
      </>}</div>
    </div>}
  </div>;
}

export function GoalMaterials({ state, goal, t, onAdd, onLink, onChatContext }) {
  return <section className="zj-card"><div className="zj-page-heading"><h3>{t('goalMaterials')}</h3><div className="zj-actions"><Button small onClick={onLink}>{t('linkExisting')}</Button><Button small onClick={onAdd}>{t('addMaterial')}</Button></div></div>
    {goal.materialLinks.map(link => { const entry = versionEntry(state, link.versionId); return entry ? <div className="zj-attach" key={link.versionId}><div><strong>{entry.material.title}</strong><span className="zj-subtle">{t(entry.material.kind === 'company' ? 'companyMaterial' : entry.material.kind)} · {t('version', { number: entry.version.revision })}</span></div>{onChatContext && <Button small disabled={!entry.version.confirmed} onClick={() => onChatContext(link.versionId)}>{t('askAboutMaterial')}</Button>}<span className="zj-tag confirmed">{t('confirmed')}</span></div> : null; })}
    {!goal.materialLinks.length && <p className="zj-subtle">{t('noConfirmed')}</p>}
  </section>;
}
