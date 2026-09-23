(function installKnowledgeCribMemoryViewProjection(root) {
  'use strict';

  function asObject(value) {
    return value && typeof value === 'object' ? value : {};
  }

  function asText(value) {
    return typeof value === 'string' ? value : '';
  }

  function compactClaim(value, max = 140) {
    const normalized = asText(value).replace(/\s+/g, ' ').trim();
    const points = Array.from(normalized);
    return points.length > max ? `${points.slice(0, max - 1).join('').trimEnd()}…` : normalized;
  }

  function healthSignals(input) {
    const health = asObject(input);
    const published = asObject(health.codeIndex);
    const reader = asObject(health.readerFreshness);
    const retrieval = asObject(health.retrieval);
    const sync = asObject(health.sync);
    const publishedRevision = asText(published.checkedRevision) || asText(reader.indexedHead);
    const readerRevision = asText(reader.indexedHead);
    const publishedBehind = published.behindHead === true;
    const readerStale = reader.stale === true;
    return [
      {
        key: 'published',
        label: 'Published index',
        status: publishedBehind ? 'Behind HEAD' : publishedRevision ? 'Current' : 'Unknown',
        tone: publishedBehind ? 'risk' : publishedRevision ? 'good' : 'muted',
        showSnapshot: true,
        revision: publishedRevision,
        revisionLabel: publishedRevision ? publishedRevision.slice(0, 12) : 'unavailable',
        lastSuccess: asText(published.lastSuccessfulAt),
        lastSuccessLabel: asText(published.lastSuccessfulAt) || 'not recorded',
        explanation: publishedBehind
          ? 'The published code index is behind the repository HEAD.'
          : publishedRevision
            ? 'The published code index was checked against this revision.'
            : 'The published code index check is unavailable.',
      },
      {
        key: 'reader',
        label: 'Reader snapshot',
        status: readerStale ? 'Stale' : readerRevision ? 'Current' : 'Unknown',
        tone: readerStale ? 'risk' : readerRevision ? 'good' : 'muted',
        showSnapshot: true,
        revision: readerRevision,
        revisionLabel: readerRevision ? readerRevision.slice(0, 12) : 'unavailable',
        lastSuccess: asText(reader.lastSuccessfulRefreshAt),
        lastSuccessLabel: asText(reader.lastSuccessfulRefreshAt) || 'not recorded',
        explanation: readerStale
          ? 'This page is reading an older code snapshot; refresh the visualization after updating the index.'
          : readerRevision
            ? 'This page is reading the indexed code snapshot shown here.'
            : 'The reader snapshot check is unavailable.',
      },
      {
        key: 'retrieval',
        label: 'Retrieval',
        status: retrieval.mode === 'on-device-semantic' ? 'On-device semantic' : 'Keyword',
        tone: 'neutral',
        revision: '',
        revisionLabel: '',
        lastSuccess: '',
        lastSuccessLabel: '',
        explanation: retrieval.mode === 'on-device-semantic'
          ? 'Search uses a model on this device.'
          : 'Search uses local keyword matching; a semantic model is unavailable.',
      },
      {
        key: 'sync',
        label: 'Sync',
        status: sync.configured === true ? 'Configured' : 'Local only',
        tone: 'neutral',
        revision: '',
        revisionLabel: '',
        lastSuccess: asText(sync.lastSuccessfulAt),
        lastSuccessLabel: asText(sync.lastSuccessfulAt) || 'not recorded',
        explanation: sync.configured === true
          ? 'Encrypted device sync is configured for this memory store.'
          : 'Memory stays local to this device until device sync is configured.',
      },
    ];
  }

  function ledgerRow(value) {
    const row = asObject(value);
    const group = asText(row.group);
    const status = group ? group[0].toUpperCase() + group.slice(1).replace(/-/g, ' ') : 'History';
    return {
      subject: asText(row.subject) || 'Untitled claim',
      preview: compactClaim(row.claim),
      status,
      timeLabel: asText(row.recordedAt) ? 'Recorded' : 'Created',
      time: asText(row.recordedAt) || asText(row.createdAt) || 'Time unavailable',
      nextAction: Array.isArray(row.reviewReasons) && row.reviewReasons.length
        ? 'Review claim'
        : 'Inspect claim',
    };
  }

  root.KCMemoryViewProjection = { compactClaim, healthSignals, ledgerRow };
})(typeof globalThis !== 'undefined' ? globalThis : window);
