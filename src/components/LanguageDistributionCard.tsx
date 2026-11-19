import React from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';
import { RecordingRecord } from '../types';
import { formatDuration } from '../utils/audio';

interface LanguageDistributionCardProps {
  records: RecordingRecord[];
  selectedLanguage?: string | null;
  onSelectLanguage: (language: string | null) => void;
}

const LANGUAGE_COLORS: Record<string, string> = {
  English: '#4f46e5',
  Spanish: '#db2777',
  French: '#2563eb',
  German: '#d97706',
  Japanese: '#dc2626',
  'Mandarin Chinese': '#059669',
  Italian: '#7c3aed',
  Portuguese: '#0891b2',
  Korean: '#ea580c',
  Hindi: '#65a30d',
};

const DEFAULT_COLORS = ['#4f46e5', '#2563eb', '#059669', '#d97706', '#db2777', '#7c3aed', '#0891b2', '#64748b'];

export const LanguageDistributionCard: React.FC<LanguageDistributionCardProps> = ({
  records,
  selectedLanguage,
  onSelectLanguage,
}) => {
  const languageData = React.useMemo(() => {
    const counts: Record<string, { count: number; totalSeconds: number }> = {};
    records.forEach((r) => {
      const rawLang = r.detected_language || 'Unknown';
      const lang = rawLang.charAt(0).toUpperCase() + rawLang.slice(1);
      if (!counts[lang]) {
        counts[lang] = { count: 0, totalSeconds: 0 };
      }
      counts[lang].count += 1;
      counts[lang].totalSeconds += r.duration_seconds || 0;
    });

    const total = records.length;
    return Object.entries(counts)
      .map(([name, stat], index) => ({
        name,
        count: stat.count,
        totalSeconds: stat.totalSeconds,
        percentage: total > 0 ? Math.round((stat.count / total) * 100) : 0,
        color: LANGUAGE_COLORS[name] || DEFAULT_COLORS[index % DEFAULT_COLORS.length],
      }))
      .sort((a, b) => b.count - a.count);
  }, [records]);

  const totalDuration = React.useMemo(
    () => records.reduce((acc, r) => acc + (r.duration_seconds || 0), 0),
    [records]
  );

  if (records.length === 0) return null;

  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-slate-100 dark:border-slate-800">
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Language Distribution
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {records.length} recordings · {languageData.length}{' '}
            {languageData.length === 1 ? 'language' : 'languages'} · Total audio{' '}
            <span className="font-mono tabular-nums">{formatDuration(totalDuration)}</span>
          </p>
        </div>

        {selectedLanguage && (
          <button
            type="button"
            onClick={() => onSelectLanguage(null)}
            className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline self-start sm:self-auto"
          >
            Clear language filter ({selectedLanguage})
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
        <div className="md:col-span-4 flex flex-col items-center">
          <div className="w-full h-44 min-w-[160px] relative">
            <ResponsiveContainer width="100%" height="100%" minWidth={160} minHeight={176}>
              <PieChart>
                <Pie
                  data={languageData}
                  cx="50%"
                  cy="50%"
                  innerRadius={44}
                  outerRadius={68}
                  paddingAngle={languageData.length > 1 ? 3 : 0}
                  dataKey="count"
                  isAnimationActive={false}
                  onClick={(entry) => {
                    onSelectLanguage(selectedLanguage === entry.name ? null : entry.name);
                  }}
                  cursor="pointer"
                >
                  {languageData.map((entry) => (
                    <Cell
                      key={entry.name}
                      fill={entry.color}
                      stroke={selectedLanguage === entry.name ? '#1e1b4b' : 'transparent'}
                      strokeWidth={selectedLanguage === entry.name ? 2 : 0}
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: unknown, _name: unknown, item: { payload?: { percentage?: number; totalSeconds?: number; name?: string } }) => [
                    `${value} clips (${item.payload?.percentage ?? 0}%) · ${formatDuration(item.payload?.totalSeconds ?? 0)}`,
                    item.payload?.name || '',
                  ]}
                  contentStyle={{
                    backgroundColor: '#0f172a',
                    borderColor: '#1e293b',
                    borderRadius: '0.5rem',
                    color: '#f8fafc',
                    fontSize: '12px',
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-lg font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {records.length}
              </span>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">Clips</span>
            </div>
          </div>
        </div>

        <div className="md:col-span-8 space-y-2">
          {languageData.map((item) => {
            const isSelected = selectedLanguage === item.name;
            return (
              <button
                key={item.name}
                type="button"
                onClick={() => onSelectLanguage(isSelected ? null : item.name)}
                className={`w-full px-3 py-2 rounded-lg border text-left flex items-center justify-between transition-colors ${
                  isSelected
                    ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-950/60 text-slate-900 dark:text-white'
                    : 'border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/50 hover:bg-slate-100 dark:hover:bg-slate-800/70 text-slate-700 dark:text-slate-200'
                }`}
              >
                <div className="flex items-center gap-2.5 text-xs">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="font-medium text-slate-900 dark:text-slate-100">{item.name}</span>
                  <span className="text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                    {item.count} {item.count === 1 ? 'clip' : 'clips'}
                  </span>
                </div>

                <div className="flex items-center gap-3 text-xs font-mono tabular-nums">
                  <span className="text-slate-500 dark:text-slate-400">
                    {formatDuration(item.totalSeconds)}
                  </span>
                  <span className="font-semibold text-slate-900 dark:text-slate-100 w-9 text-right">
                    {item.percentage}%
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
