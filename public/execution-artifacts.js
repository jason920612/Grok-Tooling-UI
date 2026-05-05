(function () {
  const ARTIFACT_DB_NAME = 'grok-tooling-ui-artifacts';
  const ARTIFACT_STORE_NAME = 'artifacts';

  const studioStatus = document.querySelector('#studio-status');
  const studioPreview = document.querySelector('#studio-preview');
  const artifactList = document.querySelector('#artifact-list');

  function fromMain(expression) {
    return window.eval(expression);
  }

  function getCurrentThread() {
    return fromMain('getCurrentThread()');
  }

  function getWorkspacePath(thread) {
    window.__artifactThread = thread;
    try {
      return fromMain('getWorkspacePath(window.__artifactThread)');
    } finally {
      delete window.__artifactThread;
    }
  }

  function saveThreads() {
    return fromMain('saveThreads()');
  }

  function render() {
    return fromMain('render()');
  }

  function sanitizeArtifactName(name) {
    return String(name || 'execution-output')
      .replace(/[^a-z0-9._-]/gi, '-')
      .replace(/-+/g, '-');
  }

  function base64ToBlob(base64, mime = 'application/octet-stream') {
    const binary = atob(base64 || '');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mime });
  }

  function openArtifactDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(ARTIFACT_DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(ARTIFACT_STORE_NAME, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function artifactStoreTransaction(mode = 'readonly') {
    const db = await openArtifactDb();
    const transaction = db.transaction(ARTIFACT_STORE_NAME, mode);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => db.close();
    transaction.onabort = () => db.close();
    return transaction.objectStore(ARTIFACT_STORE_NAME);
  }

  async function getOpfsArtifactDirectory(threadId, create = false) {
    if (!navigator.storage?.getDirectory) {
      throw new Error('OPFS is not available in this browser.');
    }
    const root = await navigator.storage.getDirectory();
    const appDirectory = await root.getDirectoryHandle('grok-tooling-ui', { create });
    const threadDirectory = await appDirectory.getDirectoryHandle(threadId, { create });
    return threadDirectory.getDirectoryHandle('artifacts', { create });
  }

  async function writeIndexedDbArtifact(key, blob) {
    const store = await artifactStoreTransaction('readwrite');
    return new Promise((resolve, reject) => {
      const request = store.put({ key, blob, updatedAt: new Date().toISOString() });
      request.onsuccess = () => resolve({ storage: 'indexeddb', key });
      request.onerror = () => reject(request.error);
    });
  }

  async function writeArtifactBlob(thread, filename, blob) {
    const key = `${thread.id}/${filename}`;
    try {
      const directory = await getOpfsArtifactDirectory(thread.id, true);
      const fileHandle = await directory.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { storage: 'opfs', key };
    } catch {
      return writeIndexedDbArtifact(key, blob);
    }
  }

  async function readIndexedDbArtifactBlob(key) {
    const store = await artifactStoreTransaction();
    return new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result;
        if (!record) {
          reject(new Error('Artifact content was not found.'));
          return;
        }
        resolve(record.blob instanceof Blob ? record.blob : new Blob([String(record.content || '')]));
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function readArtifactBlob(artifact) {
    if (artifact.storage === 'opfs') {
      try {
        const directory = await getOpfsArtifactDirectory(artifact.threadId || getCurrentThread().id);
        const fileHandle = await directory.getFileHandle(artifact.name);
        return fileHandle.getFile();
      } catch {
        return readIndexedDbArtifactBlob(artifact.key);
      }
    }
    return readIndexedDbArtifactBlob(artifact.key);
  }

  function isPreviewable(file, blob) {
    const mime = file.mime || blob.type || '';
    const name = String(file.name || '');
    return (
      mime.startsWith('text/') ||
      mime.startsWith('image/') ||
      mime === 'application/pdf' ||
      /\.(html?|json|csv|md|svg|txt|log)$/i.test(name)
    );
  }

  async function importToolArtifacts(toolResults) {
    const thread = getCurrentThread();
    const imported = [];

    for (const result of Array.isArray(toolResults) ? toolResults : []) {
      for (const file of Array.isArray(result.artifacts) ? result.artifacts : []) {
        const filename = sanitizeArtifactName(file.name || `execution-output-${Date.now()}`);
        const blob = base64ToBlob(file.content_base64, file.mime);
        const storage = await writeArtifactBlob(thread, filename, blob);
        imported.push({
          path: `${getWorkspacePath(thread)}/${filename}`,
          name: filename,
          language: 'execution-output',
          mime: file.mime || blob.type || 'application/octet-stream',
          previewable: Boolean(file.previewable) || isPreviewable(file, blob),
          size: file.size || blob.size,
          threadId: thread.id,
          storage: storage.storage,
          key: storage.key,
          createdAt: new Date().toISOString()
        });
      }
    }

    if (imported.length === 0) return;
    thread.studio.artifacts.unshift(...imported);
    thread.updatedAt = new Date().toISOString();
    saveThreads();
    render();
    studioStatus.textContent = `Imported ${imported.length} execution output file(s) into ${getWorkspacePath(thread)}.`;
    studioStatus.className = 'studio-status ok';
  }

  async function downloadArtifact(artifact) {
    try {
      const blob = await readArtifactBlob(artifact);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = artifact.name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      studioStatus.textContent = error instanceof Error ? error.message : String(error);
      studioStatus.className = 'studio-status error';
    }
  }

  async function previewArtifact(artifact) {
    try {
      const blob = await readArtifactBlob(artifact);
      const mime = artifact.mime || blob.type || 'application/octet-stream';
      studioPreview.removeAttribute('src');

      if (mime.startsWith('image/') || mime === 'application/pdf') {
        studioPreview.removeAttribute('srcdoc');
        studioPreview.src = URL.createObjectURL(blob);
      } else {
        const text = await blob.text();
        if (mime.startsWith('text/html') || /\.(html?|svg)$/i.test(artifact.name)) {
          studioPreview.srcdoc = text;
        } else {
          studioPreview.srcdoc = `<!doctype html><pre>${escapeHtml(text)}</pre>`;
        }
      }
      studioStatus.textContent = `Previewing ${artifact.path}`;
      studioStatus.className = 'studio-status ok';
    } catch (error) {
      studioStatus.textContent = error instanceof Error ? error.message : String(error);
      studioStatus.className = 'studio-status error';
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  window.eval(`
    renderArtifacts = function renderArtifacts() {
      const artifacts = getCurrentThread().studio.artifacts;
      artifactList.innerHTML = '';
      if (artifacts.length === 0) {
        artifactList.innerHTML = '<p class="trace-muted">No persistent files yet.</p>';
        return;
      }
      for (const artifact of artifacts) {
        const row = document.createElement('div');
        row.className = 'artifact-item';
        const name = document.createElement('span');
        name.textContent = artifact.path + ' (' + (artifact.storage || 'legacy') + ')';
        row.append(name);
        if (artifact.previewable) {
          const preview = document.createElement('button');
          preview.type = 'button';
          preview.textContent = 'Preview';
          preview.addEventListener('click', () => window.__executionArtifacts.previewArtifact(artifact));
          row.appendChild(preview);
        }
        const download = document.createElement('button');
        download.type = 'button';
        download.textContent = 'Download';
        download.addEventListener('click', () => window.__executionArtifacts.downloadArtifact(artifact));
        row.appendChild(download);
        artifactList.appendChild(row);
      }
    };
  `);

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    if (String(url).endsWith('/api/chat')) {
      response.clone().json()
        .then((data) => importToolArtifacts(data.toolResults))
        .catch(() => undefined);
    }
    return response;
  };

  window.__executionArtifacts = {
    downloadArtifact,
    previewArtifact,
    importToolArtifacts
  };
})();
