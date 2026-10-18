import { useState, useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import AudioPlayer from '@/components/custom/AudioPlayer';
import CoverArt from '@/components/custom/CoverArt';
import { MusicTrack } from '@shared/types/api';
import { musicApi, aiApi, plazaApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

const STYLES = [
  { id: 'pop', label: '流行' },
  { id: 'classical', label: '古典' },
  { id: 'electronic', label: '电子' },
  { id: 'jazz', label: '爵士' },
  { id: 'folk', label: '民谣' },
];

const MOODS = [
  { value: 'happy', label: '欢快' },
  { value: 'calm', label: '平静' },
  { value: 'sad', label: '悲伤' },
  { value: 'energetic', label: '激昂' },
];

/** 轮询间隔（毫秒） */
const POLL_INTERVAL = 4000;
/** 最大轮询时长 6 分钟 */
const POLL_TIMEOUT = 6 * 60 * 1000;

interface HomeProps {
  onNavigate?: (path: string) => void;
}

export default function Home({ onNavigate }: HomeProps) {
  const { user, refreshUser } = useAuth();
  const quotaRemaining = user?.quotaRemaining ?? 0;

  const [prompt, setPrompt] = useState('');
  const [selectedStyle, setSelectedStyle] = useState('pop');
  const [mood, setMood] = useState('calm');
  const [withVocal, setWithVocal] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState('');
  const [elapsed, setElapsed] = useState(0); // 已用秒数，用于预估剩余时间

  /** Suno 平均生成时长（秒），用于预估剩余时间 */
  const ESTIMATED_DURATION = 90;

  const [versions, setVersions] = useState<MusicTrack[]>([]);
  const [recent, setRecent] = useState<MusicTrack[]>([]);

  // AI 润色预览
  const [optimizing, setOptimizing] = useState(false);
  const [optimized, setOptimized] = useState<{ sunoPrompt: string; tags: string } | null>(null);

  // 分享弹窗
  const [shareTrack, setShareTrack] = useState<MusicTrack | null>(null);
  const [shareDesc, setShareDesc] = useState('');
  const [sharing, setSharing] = useState(false);

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  /** 服务端记录 → AudioPlayer 兼容结构 */
  const toTrack = useCallback((r: {
    id: string; title: string; description: string; audioUrl?: string | null;
    tags: string; mood: string; prompt: string; createdAt: string;
    duration?: number | null; sunoId?: string | null;
  }): MusicTrack => ({
    id: r.id,
    title: r.title,
    description: r.description,
    audioUrl: r.audioUrl || '',
    style: r.tags || '',
    mood: r.mood,
    duration: r.duration ?? 0,
    prompt: r.prompt,
    sunoId: r.sunoId ?? null,
    createdAt: r.createdAt,
  }), []);

  const loadRecent = useCallback(async () => {
    try {
      const list = await musicApi.list();
      setRecent(list.filter((m) => m.status === 'completed').slice(0, 5).map(toTrack));
    } catch {
      // 列表加载失败不阻塞页面
    }
  }, []);

  useEffect(() => {
    loadRecent();
    // 广场「用此提示词创作」跳转过来的预填
    const prefill = sessionStorage.getItem('aimusic_prefill_prompt');
    if (prefill) {
      setPrompt(prefill);
      sessionStorage.removeItem('aimusic_prefill_prompt');
    }
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [loadRecent]);

  // 人声开关智能联动：prompt 含人声相关关键词时自动点亮，否则关闭
  // 仅在 prompt 变化时联动，用户手动点开关不触发 prompt 变化，不会被覆盖
  useEffect(() => {
    const text = prompt.toLowerCase();
    const vocalKeywords = ['人声', '演唱', '唱歌', '主唱', '歌声', 'vocal', 'vocals', 'rap', '说唱', '歌词', '吟唱', '歌手', '副歌'];
    const hasVocal = vocalKeywords.some((k) => text.includes(k));
    setWithVocal(hasVocal);
  }, [prompt]);

  /** 轮询 group 直到两条版本都完成/失败 */
  const pollGroup = useCallback((gid: string) => {
    const startedAt = Date.now();
    if (pollTimer.current) clearInterval(pollTimer.current);

    pollTimer.current = setInterval(async () => {
      try {
        const records = await musicApi.groupQuery(gid);
        const tracks = records.map(toTrack);
        // 任何一条完成就先展示，提升感知速度
        setVersions((prev) => {
          if (prev.length === tracks.length) return prev;
          return tracks;
        });

        const allDone = records.every((r) => r.status === 'completed' || r.status === 'failed');
        if (allDone) {
          if (pollTimer.current) clearInterval(pollTimer.current);
          setGenerating(false);
          setVersions(tracks);
          const completed = tracks.filter((_, i) => records[i].status === 'completed');
          if (completed.length > 0) {
            setProgress(100);
            setRecent((prev) => [...completed, ...prev].slice(0, 5));
            refreshUser();
            toast.success(`生成完成：${completed.length} 个版本已就绪`);
          } else {
            const failReason = records.find((r) => r.status === 'failed')?.failReason;
            refreshUser();
            toast.error(failReason || '生成失败，请调整描述后重试');
          }
        } else if (Date.now() - startedAt > POLL_TIMEOUT) {
          if (pollTimer.current) clearInterval(pollTimer.current);
          setGenerating(false);
          setVersions(tracks);
          toast.error('生成超时，可稍后在音乐库查看结果');
        }
      } catch {
        // 单次轮询失败忽略，下一轮重试
      }
    }, POLL_INTERVAL);
  }, [refreshUser, toTrack]);

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) {
      toast.error('请输入音乐描述');
      return;
    }
    if (quotaRemaining <= 0) {
      toast.error('今日生成额度已用完，明天再来吧');
      return;
    }

    setGenerating(true);
    setProgress(5);
    setElapsed(0);
    setPhase('DeepSeek 润色提示词中...');
    setVersions([]);
    setOptimized(null);

    // 模拟进度（真实生成 30s-2min）
    const progressTimer = setInterval(() => {
      setProgress((prev) => Math.min(prev + Math.random() * 3, 95));
    }, 1500);
    setTimeout(() => setPhase('Suno 谱曲中，请耐心等待...'), 6000);

    try {
      const { groupId: gid, versions: recs, polishFailed } = await musicApi.generate({
        prompt: prompt.trim(),
        style: selectedStyle,
        mood,
        instrumental: !withVocal,
      });
      if (polishFailed) {
        toast.warning('AI 润色未生效（参数可能较简单），将使用原始描述生成');
      }
      setVersions(recs.map(toTrack));
      setProgress((prev) => Math.max(prev, 20));
      setPhase('已提交生成任务，Suno 正在谱曲...');
      refreshUser();
      // 轮询 group，两条版本各自完成后展示
      pollGroup(gid);
    } catch (err) {
      clearInterval(progressTimer);
      setGenerating(false);
      setProgress(0);
      toast.error(err instanceof Error ? err.message : '发起生成失败');
    }
  }, [prompt, selectedStyle, mood, withVocal, quotaRemaining, refreshUser, pollGroup]);

  // 进度条计时器在 generating 结束后清理
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => {
      setProgress((prev) => Math.min(prev + Math.random() * 3, 95));
      setElapsed((prev) => prev + 1);
    }, 1500);
    return () => clearInterval(timer);
  }, [generating]);

  const handleOptimize = useCallback(async () => {
    if (!prompt.trim()) {
      toast.error('请先输入音乐描述');
      return;
    }
    setOptimizing(true);
    try {
      const result = await aiApi.optimizePrompt({
        prompt: prompt.trim(),
        style: selectedStyle,
        mood,
      });
      setOptimized({ sunoPrompt: result.sunoPrompt, tags: result.tags });
      toast.success('润色完成');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '润色失败');
    } finally {
      setOptimizing(false);
    }
  }, [prompt, selectedStyle, mood]);

  const handleDownload = useCallback(async (track: MusicTrack) => {
    if (!track) return;
    try {
      const { url } = await musicApi.downloadUrl(track.id);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${track.title}.mp3`;
      a.target = '_blank';
      a.click();
      toast.success('开始下载...');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '获取下载链接失败');
    }
  }, []);

  const handleShare = useCallback(async () => {
    if (!shareTrack) return;
    setSharing(true);
    try {
      await plazaApi.create({
        musicId: shareTrack.id,
        description: shareDesc.trim(),
      });
      toast.success('已分享到广场');
      setShareTrack(null);
      setShareDesc('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '分享失败');
    } finally {
      setSharing(false);
    }
  }, [shareTrack, shareDesc]);

  /** 延长 / 翻唱：基于已有音乐的 sunoId 生成新版本 */
  const handleExtendCover = useCallback(async (track: MusicTrack, taskType: 'extend' | 'cover') => {
    if (!track.sunoId) {
      toast.error('该音乐缺少 Suno 标识，无法延长/翻唱');
      return;
    }
    if (quotaRemaining <= 0) {
      toast.error('今日生成额度已用完，明天再来吧');
      return;
    }
    setGenerating(true);
    setProgress(5);
    setElapsed(0);
    setPhase(taskType === 'extend' ? '正在续写音乐...' : '正在翻唱音乐...');
    setVersions([]);

    try {
      const { groupId: gid, versions: recs } = await musicApi.generate({
        taskType,
        referenceClipId: track.sunoId,
        instrumental: true,
      });
      setVersions(recs.map(toTrack));
      setProgress(20);
      setPhase('Suno 正在处理，请耐心等待...');
      refreshUser();
      pollGroup(gid);
    } catch (err) {
      setGenerating(false);
      setProgress(0);
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  }, [quotaRemaining, refreshUser, pollGroup, toTrack]);

  return (
    <div className="grain max-w-screen-xl mx-auto px-4 sm:px-6 lg:px-8 pb-20">
      {/* Hero —— 编辑式左对齐 */}
      <section className="py-12 md:py-16 reveal-up" style={{ ['--stagger' as any]: 0 }}>
        <p className="index-no mb-4">SOUNDPICK · AI 音乐生成</p>
        <h1
          className="font-display text-4xl md:text-5xl lg:text-6xl mb-4 tracking-tight"
          style={{ color: 'var(--sp-ink)' }}
        >
          让灵感随乐而动
        </h1>
        <p className="text-base max-w-2xl" style={{ color: 'var(--sp-ink-dim)' }}>
          输入一段描述，DeepSeek 润色提示词，Suno 谱写真正的原创音乐，支持下载与分享。
        </p>
        {/* 细线 + 装饰波形竖线 */}
        <div className="mt-8 flex items-center gap-4">
          <div className="flex items-end gap-[3px]" aria-hidden="true">
            {[14, 24, 10, 28, 16, 22, 8, 26, 12, 18].map((h, i) => (
              <span
                key={i}
                className="w-px"
                style={{ height: h, background: i === 3 ? 'var(--sp-accent)' : 'var(--sp-ink-ghost)' }}
              />
            ))}
          </div>
          <div className="h-px flex-1" style={{ background: 'var(--sp-line)' }} />
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* 左侧表单 */}
        <div className="lg:col-span-5">
          <div
            className="surface rounded-md p-6 md:p-8 reveal-up"
            style={{ border: '1px solid var(--sp-line)', ['--stagger' as any]: 1 }}
          >
            <div className="flex items-baseline justify-between mb-6">
              <h2 className="font-display text-xl" style={{ color: 'var(--sp-ink)' }}>创作参数</h2>
              <span className="index-no">CONSOLE</span>
            </div>

            <div className="space-y-6">
              {/* Prompt */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <label className="index-no">PROMPT · 音乐描述</label>
                  <button
                    onClick={handleOptimize}
                    disabled={optimizing || generating}
                    className="text-xs px-3 py-1.5 rounded-md font-medium transition-all disabled:opacity-50 flex items-center gap-1 hover:-translate-y-0.5"
                    style={{
                      background: 'var(--sp-accent)',
                      color: '#14120E',
                      boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
                    }}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    {optimizing ? '润色中...' : 'AI 润色'}
                  </button>
                </div>
                <textarea
                  rows={3}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="例如：一段轻松的爵士风格，适合午后咖啡馆，带有萨克斯风旋律..."
                  className="w-full rounded-sm p-3 text-sm outline-none transition-colors resize-none placeholder:text-[var(--sp-ink-ghost)]"
                  style={{ background: 'var(--sp-surface-2)', border: '1px solid var(--sp-line)', color: 'var(--sp-ink)' }}
                  onFocus={(e) => (e.target.style.borderColor = 'var(--sp-accent)')}
                  onBlur={(e) => (e.target.style.borderColor = 'var(--sp-line)')}
                />
                {optimized && (
                  <div
                    className="mt-2 p-3 surface-2 rounded-sm text-xs space-y-1.5"
                    style={{ borderLeft: '2px solid var(--sp-accent)' }}
                  >
                    <p className="index-no">OPTIMIZED · 生成时自动使用</p>
                    <p style={{ color: 'var(--sp-ink)' }}>{optimized.sunoPrompt}</p>
                    <p style={{ color: 'var(--sp-ink-ghost)' }}>TAGS · {optimized.tags}</p>
                  </div>
                )}
              </div>

              {/* Style tags */}
              <div>
                <label className="index-no block mb-3">STYLE · 风格</label>
                <div className="flex flex-wrap gap-2">
                  {STYLES.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setSelectedStyle(s.id)}
                      className="px-4 py-1.5 rounded-md text-sm transition-all"
                      style={
                        selectedStyle === s.id
                          ? { background: 'var(--sp-accent)', color: '#14120E', border: '1px solid var(--sp-accent)', fontWeight: 600 }
                          : { background: 'transparent', color: 'var(--sp-ink-dim)', border: '1px solid var(--sp-line)' }
                      }
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Mood + Vocal */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="index-no block mb-2">MOOD · 情绪</label>
                  <select
                    value={mood}
                    onChange={(e) => setMood(e.target.value)}
                    className="w-full rounded-sm p-2.5 text-sm outline-none"
                    style={{ background: 'var(--sp-surface-2)', border: '1px solid var(--sp-line)', color: 'var(--sp-ink)' }}
                  >
                    {MOODS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="index-no block mb-2">VOCAL · 人声</label>
                  <button
                    onClick={() => setWithVocal(!withVocal)}
                    className="w-full rounded-sm p-2.5 text-sm transition-all text-left relative font-medium"
                    title="根据描述自动检测，可手动覆盖"
                    style={{
                      background: withVocal ? 'var(--sp-accent)' : 'var(--sp-surface-2)',
                      border: withVocal ? '1px solid var(--sp-accent)' : '1px solid var(--sp-line)',
                      color: withVocal ? '#14120E' : 'var(--sp-ink-dim)',
                    }}
                  >
                    {withVocal ? '♪ 包含人声' : '纯音乐（无人声）'}
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] opacity-60" style={{ color: withVocal ? '#14120E' : 'var(--sp-ink-ghost)' }}>AUTO</span>
                  </button>
                </div>
              </div>

              {/* Generate button */}
              <button
                onClick={handleGenerate}
                disabled={generating || quotaRemaining <= 0}
                className="w-full py-4 rounded-md font-bold text-lg transition-all flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed hover:-translate-y-0.5"
                style={{ background: 'var(--sp-accent)', color: '#14120E' }}
              >
                {generating ? (
                  <>
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    AI 正在谱曲中...
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    立即生成
                  </>
                )}
              </button>

              {/* Progress */}
              {generating && (
                <div className="space-y-2">
                  <div className="relative h-1 w-full rounded-full overflow-hidden" style={{ background: 'var(--sp-line)' }}>
                    <div
                      className="absolute left-0 top-0 h-full rounded-full transition-all duration-700"
                      style={{ width: `${progress}%`, background: 'var(--sp-accent)' }}
                    />
                  </div>
                  <div className="flex justify-between items-center">
                    <p className="index-no text-xs">
                      PHASE {phase.includes('Suno') ? '02' : phase.includes('已提交') || phase.includes('正在') ? '03' : '01'} · {phase || '准备中...'}
                    </p>
                    <p className="index-no text-xs" style={{ color: 'var(--sp-ink-dim)' }}>
                      {Math.round(progress)}% · 预估剩余 {Math.max(0, ESTIMATED_DURATION - elapsed)}s
                    </p>
                  </div>
                </div>
              )}

              <p className="text-center text-xs" style={{ color: 'var(--sp-ink-dim)' }}>
                剩余生成次数：
                <span className="font-medium" style={{ color: 'var(--sp-ink)' }}>{quotaRemaining}/10</span>
                {quotaRemaining <= 0 && (
                  <span className="block mt-1" style={{ color: 'var(--sp-error)' }}>今日额度已用完，明天自动恢复</span>
                )}
              </p>
            </div>
          </div>
        </div>

        {/* 右侧结果 */}
        <div className="lg:col-span-7 space-y-6">
          {versions.length > 0 ? (
            <div className="reveal-up" style={{ ['--stagger' as any]: 2 }}>
              <div className="flex items-baseline justify-between mb-3">
                <h3 className="font-display text-lg" style={{ color: 'var(--sp-ink)' }}>
                  {versions.length === 1 ? '生成结果' : `生成结果 · ${versions.length} 个版本`}
                </h3>
                {versions.some((v) => !v.audioUrl) && (
                  <span className="index-no" style={{ color: 'var(--sp-accent)' }}>生成中…</span>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {versions.map((track, idx) => (
                  <div
                    key={track.id}
                    className="surface rounded-md p-4 flex flex-col"
                    style={{ border: '1px solid var(--sp-line)' }}
                  >
                    {/* 版本头 */}
                    <div className="flex items-center gap-3 mb-3">
                      <div
                        className="w-12 h-12 rounded-sm overflow-hidden flex-shrink-0"
                        style={{ border: '1px solid var(--sp-line)' }}
                      >
                        <CoverArt seed={track.title + idx} size={48} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="index-no block">V{idx + 1}</span>
                        <p className="font-display truncate" style={{ color: 'var(--sp-ink)' }}>{track.title}</p>
                      </div>
                    </div>
                    {/* 播放器或生成中 */}
                    {track.audioUrl ? (
                      <AudioPlayer track={track} onDownload={() => handleDownload(track)} />
                    ) : (
                      <div
                        className="rounded-sm p-6 flex flex-col items-center justify-center text-center"
                        style={{ background: 'var(--sp-surface-2)', border: '1px dashed var(--sp-line)' }}
                      >
                        <svg className="w-6 h-6 animate-spin mb-2" style={{ color: 'var(--sp-accent)' }} fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        <p className="text-xs index-no" style={{ color: 'var(--sp-ink-dim)' }}>Suno 谱曲中…</p>
                      </div>
                    )}
                    {/* 操作按钮：延长 / 翻唱 / 分享 */}
                    {track.audioUrl && (
                      <div className="flex justify-end gap-2 mt-3">
                        <button
                          onClick={() => handleExtendCover(track, 'extend')}
                          disabled={generating}
                          className="text-xs px-3 py-1.5 rounded-md transition-colors flex items-center gap-1.5 disabled:opacity-50"
                          style={{ border: '1px solid var(--sp-line)', color: 'var(--sp-ink-dim)' }}
                          onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.color = 'var(--sp-accent)'; }}
                          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--sp-ink-dim)')}
                          title="基于此音频续写更长版本"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                          </svg>
                          延长
                        </button>
                        <button
                          onClick={() => handleExtendCover(track, 'cover')}
                          disabled={generating}
                          className="text-xs px-3 py-1.5 rounded-md transition-colors flex items-center gap-1.5 disabled:opacity-50"
                          style={{ border: '1px solid var(--sp-line)', color: 'var(--sp-ink-dim)' }}
                          onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.color = 'var(--sp-accent)'; }}
                          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--sp-ink-dim)')}
                          title="基于此音频翻唱"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                          </svg>
                          翻唱
                        </button>
                        <button
                          onClick={() => setShareTrack(track)}
                          className="text-xs px-3 py-1.5 rounded-md transition-colors flex items-center gap-1.5"
                          style={{ border: '1px solid var(--sp-line)', color: 'var(--sp-ink-dim)' }}
                          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--sp-accent)')}
                          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--sp-ink-dim)')}
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.367 2.684 3 3 0 00-5.367-2.684z" />
                          </svg>
                          分享
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div
              className="surface rounded-md p-12 flex flex-col items-center justify-center text-center min-h-[200px] reveal-up"
              style={{ border: '1px dashed var(--sp-line)', ['--stagger' as any]: 2 }}
            >
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center mb-4 surface-2"
                style={{ border: '1px solid var(--sp-line)' }}
              >
                <svg className="w-8 h-8" style={{ color: 'var(--sp-accent)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                </svg>
              </div>
              <p className="font-medium" style={{ color: 'var(--sp-ink)' }}>输入描述并点击「立即生成」</p>
              <p className="text-sm mt-1" style={{ color: 'var(--sp-ink-dim)' }}>每次生成 2 个版本，可对比后下载或分享</p>
            </div>
          )}

          {/* 最近生成 */}
          {recent.length > 0 && (
            <div
              className="surface rounded-md p-6 reveal-up"
              style={{ border: '1px solid var(--sp-line)', ['--stagger' as any]: 3 }}
            >
              <div className="flex justify-between items-baseline mb-2">
                <div>
                  <span className="index-no block mb-1">RECENT</span>
                  <h4 className="font-display text-lg" style={{ color: 'var(--sp-ink)' }}>最近生成</h4>
                </div>
                <button
                  onClick={() => onNavigate?.('/library')}
                  className="text-xs hover:underline"
                  style={{ color: 'var(--sp-accent)' }}
                >
                  前往音乐库
                </button>
              </div>
              <div>
                {recent.slice(0, 3).map((track, idx) => (
                  <div
                    key={track.id}
                    className="flex items-center gap-4 py-3 px-2 -mx-2 rounded-sm transition-colors cursor-pointer group"
                    style={{ borderTop: idx === 0 ? 'none' : '1px solid var(--sp-line-subtle)' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--sp-surface-2)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    onClick={() => setVersions([track])}
                  >
                    <div
                      className="w-16 h-16 rounded-sm overflow-hidden flex-shrink-0"
                      style={{ border: '1px solid var(--sp-line)' }}
                    >
                      <CoverArt seed={track.title} size={64} />
                    </div>
                    <div className="flex-grow min-w-0">
                      <p className="font-display truncate" style={{ color: 'var(--sp-ink)' }}>{track.title}</p>
                      <p className="text-xs mt-1 flex items-center gap-2" style={{ color: 'var(--sp-ink-dim)' }}>
                        <span className="index-no">No.{String(idx + 1).padStart(3, '0')}</span>
                        <span>
                          {new Date(track.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </p>
                    </div>
                    <svg
                      className="w-5 h-5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      style={{ color: 'var(--sp-accent)' }}
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 分享弹窗 */}
      {shareTrack && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ background: 'rgba(20,18,14,0.75)' }}
          onClick={() => setShareTrack(null)}
        >
          <div
            className="w-full max-w-md rounded-md p-6 surface-2"
            style={{ border: '1px solid var(--sp-line)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="index-no mb-2">SHARE</p>
            <h3 className="font-display text-lg mb-1" style={{ color: 'var(--sp-ink)' }}>分享到广场</h3>
            <p className="text-sm mb-4" style={{ color: 'var(--sp-ink-dim)' }}>「{shareTrack.title}」— 音频与提示词将一起公开</p>
            <textarea
              rows={3}
              value={shareDesc}
              onChange={(e) => setShareDesc(e.target.value)}
              placeholder="简单介绍一下这首音乐（可选）..."
              className="w-full rounded-sm p-3 text-sm outline-none resize-none mb-4 placeholder:text-[var(--sp-ink-ghost)]"
              style={{ background: 'var(--sp-surface)', border: '1px solid var(--sp-line)', color: 'var(--sp-ink)' }}
              onFocus={(e) => (e.target.style.borderColor = 'var(--sp-accent)')}
              onBlur={(e) => (e.target.style.borderColor = 'var(--sp-line)')}
            />
            <div className="flex gap-3">
              <button
                onClick={() => setShareTrack(null)}
                className="flex-1 py-2.5 rounded-md text-sm transition-colors"
                style={{ border: '1px solid var(--sp-line)', color: 'var(--sp-ink-dim)' }}
              >
                取消
              </button>
              <button
                onClick={handleShare}
                disabled={sharing}
                className="flex-1 py-2.5 rounded-md text-sm font-bold disabled:opacity-60"
                style={{ background: 'var(--sp-accent)', color: '#14120E' }}
              >
                {sharing ? '分享中...' : '确认分享'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
