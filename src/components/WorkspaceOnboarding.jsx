import { FolderOpen, Plus, UploadSimple } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { friendlyDataMessage } from "../lib/friendlyMessages.js";
import { parseUserStateBackup } from "../lib/userState.js";
import { useLabStore } from "../store/useLabStore.js";

function readTextFile(file) {
  if (typeof file?.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("无法读取备份文件"));
    reader.readAsText(file);
  });
}

export function WorkspaceOnboarding() {
  const initializeEmptyWorkspace = useLabStore((state) => state.initializeEmptyWorkspace);
  const replaceUserState = useLabStore((state) => state.replaceUserState);
  const fileInput = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const startEmpty = async () => {
    setBusy(true);
    setError("");
    try {
      await initializeEmptyWorkspace();
    } catch (cause) {
      setError(friendlyDataMessage(cause, "空工作区暂时无法保存，请稍后重试"));
    } finally {
      setBusy(false);
    }
  };

  const importBackup = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const snapshot = parseUserStateBackup(await readTextFile(file));
      await replaceUserState(snapshot);
    } catch (cause) {
      setError(friendlyDataMessage(cause, "备份暂时无法导入，请选择 FolioMind JSON 备份"));
    } finally {
      setBusy(false);
    }
  };

  return <div className="workspace-onboarding-backdrop" role="presentation">
    <section className="workspace-onboarding" role="dialog" aria-modal="true" aria-labelledby="workspace-onboarding-title">
      <div className="workspace-onboarding-mark" aria-hidden="true"><FolderOpen size={24} /></div>
      <div className="workspace-onboarding-heading">
        <h1 id="workspace-onboarding-title">先建立你的工作区</h1>
        <p>FolioMind 不会替你填入示例行情。选择一种方式开始，之后的自选、组合和盯盘设置会保存在本机。</p>
      </div>
      <div className="workspace-onboarding-actions">
        <button type="button" className="primary-action" disabled={busy} onClick={() => { void startEmpty(); }}><Plus size={16} />从空工作区开始</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => fileInput.current?.click()}><UploadSimple size={16} />导入已有状态</button>
      </div>
      <input ref={fileInput} className="visually-hidden" type="file" accept="application/json,.json" aria-label="导入 FolioMind JSON 备份" onChange={(event) => { void importBackup(event); }} />
      <p className="workspace-onboarding-note">已有设备上的数据？请从设置导出的 JSON 备份导入；API Key、模型配置和行情缓存不会写入备份。</p>
      {busy && <p className="workspace-onboarding-status" role="status">正在保存本地工作区…</p>}
      {error && <p className="workspace-onboarding-error" role="alert">{error}</p>}
    </section>
  </div>;
}
