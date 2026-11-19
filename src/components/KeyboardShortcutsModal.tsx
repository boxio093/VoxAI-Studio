import React from 'react';
import { X, Keyboard } from 'lucide-react';

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({
  isOpen,
  onClose,
}) => {
  if (!isOpen) return null;

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const modKey = isMac ? '⌘' : 'Ctrl';

  const shortcuts = [
    { keys: [modKey, 'K'], action: 'Search Transcriptions', description: 'Jump to Transcriptions and focus search bar' },
    { keys: [modKey, 'N'], action: 'Open Voice Studio', description: 'Switch to Studio workspace' },
    { keys: ['Alt', '1 - 6'], action: 'Switch Views', description: '1: Studio, 2: Recordings, 3: Transcriptions, 4: TTS, 5: Models, 6: Settings' },
    { keys: ['Space'], action: 'Play / Pause', description: 'Toggle playback inside Read-Along modal' },
    { keys: ['Esc'], action: 'Close Modal', description: 'Dismiss active modal' },
    { keys: ['?'], action: 'Keyboard Shortcuts', description: 'Toggle this reference dialog' },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-modal-title"
      className="fixed inset-0 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4 z-50"
    >
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 max-w-lg w-full overflow-hidden">
        <div className="p-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Keyboard className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <h3 id="shortcuts-modal-title" className="font-semibold text-slate-900 dark:text-slate-100 text-base">
              Keyboard Shortcuts
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close shortcuts"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 divide-y divide-slate-100 dark:divide-slate-800 max-h-[70vh] overflow-y-auto">
          {shortcuts.map((s, idx) => (
            <div key={idx} className="py-3 flex items-center justify-between gap-4 text-xs">
              <div>
                <span className="font-medium text-slate-900 dark:text-slate-100 block">{s.action}</span>
                <span className="text-slate-500 dark:text-slate-400">{s.description}</span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {s.keys.map((k, i) => (
                  <kbd
                    key={i}
                    className="px-2 py-1 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono text-[11px] font-medium text-slate-700 dark:text-slate-200"
                  >
                    {k}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
