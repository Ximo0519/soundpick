import { useState, useRef, useEffect } from 'react';
import { MusicTrack } from '@shared/types/api';
import CoverArt from '@/components/custom/CoverArt';

interface AudioPlayerProps {
  track: MusicTrack;
  onDownload?: () => void;
}

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2];

export default function AudioPlayer({ track, onDownload }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [progressHover, setProgressHover] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onDurationChange = () => setDuration(audio.duration || 0);
    const onEnded = () => setIsPlaying(false);
    const onCanPlay = () => setLoading(false);
    const onWaiting = () => setLoading(true);

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('canplay', onCanPlay);
    audio.addEventListener('waiting', onWaiting);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('canplay', onCanPlay);
      audio.removeEventListener('waiting', onWaiting);
    };
  }, [track.audioUrl]);

  /** 同步倍速和音量到 audio 元素 */
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = playbackRate;
    audio.volume = muted ? 0 : volume;
  }, [playbackRate, volume, muted]);

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      setLoading(true);
      try {
        await audio.play();
        setIsPlaying(true);
      } catch {
        setIsPlaying(false);
      } finally {
        setLoading(false);
      }
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const t = parseFloat(e.target.value);
    audio.currentTime = t;
    setCurrentTime(t);
  };

  const formatTime = (s: number) => {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  // AI 返回的实际风格标签（英文逗号分隔），格式化展示
  const styleTags = track.style
    ? track.style.split(',').map((s) => s.trim()).filter(Boolean).join(' · ')
    : '—';
  // mood 现在是 AI 判断的实际中文情绪
  const moodText = track.mood || '—';

  return (
    <div className="surface rounded-md p-6 md:p-8" style={{ border: '1px solid var(--sp-line)' }}>
      <audio ref={audioRef} src={track.audioUrl} preload="metadata" />

      <div className="flex flex-col md:flex-row gap-8 items-center">
        {/* 黑胶唱盘 + 封套 */}
        <div className="relative flex-shrink-0 w-52 h-44 md:w-64 md:h-56">
          {/* 封套：右半探出 */}
          <div
            className="surface-2 rounded-sm absolute top-0 right-0 h-full w-44 md:w-56"
            style={{ border: '1px solid var(--sp-line)' }}
          >
            <div className="absolute top-0 bottom-0 right-2 w-[2px]" style={{ background: 'var(--sp-accent)' }} />
            <div className="absolute top-0 bottom-0 right-4 w-px" style={{ background: 'var(--sp-line)' }} />
          </div>
          {/* 唱片：播放时旋转，暂停时停在原角度 */}
          <div
            className={`absolute top-0 left-0 w-44 h-44 md:w-56 md:h-56 rounded-full vinyl-spin${isPlaying ? '' : ' vinyl-paused'}`}
            style={{
              background:
                'conic-gradient(from 210deg, transparent 0deg, rgba(242,234,217,0.07) 25deg, transparent 70deg), repeating-radial-gradient(circle, #111110 0 2px, #1C1A16 2px 4px)',
              border: '1px solid var(--sp-line)',
              boxShadow: '0 10px 28px rgba(0,0,0,0.5)',
            }}
          >
            {/* 中心圆形标签 */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div
                className="w-[38%] aspect-square rounded-full overflow-hidden"
                style={{ border: '1px solid var(--sp-line)' }}
              >
                <CoverArt seed={track.title} size={100} className="w-full h-full" />
              </div>
            </div>
            {/* 轴心孔 */}
            <div
              className="absolute top-1/2 left-1/2 w-2 h-2 rounded-full"
              style={{ transform: 'translate(-50%,-50%)', background: 'var(--sp-bg)', border: '1px solid var(--sp-line)' }}
            />
          </div>
        </div>

        {/* 信息与控制 */}
        <div className="flex-grow w-full min-w-0">
          <div className="flex justify-between items-start gap-3">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="index-no">STYLE · {styleTags}</span>
              <span className="index-no">MOOD · {moodText}</span>
            </div>
            <button
              onClick={onDownload}
              className="p-2 rounded-sm transition-colors flex-shrink-0"
              style={{ border: '1px solid var(--sp-line)', color: 'var(--sp-ink-dim)' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--sp-accent)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--sp-ink-dim)')}
              title="下载"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </button>
          </div>

          <h3 className="font-display text-2xl md:text-3xl mt-2" style={{ color: 'var(--sp-ink)' }}>
            {track.title}
          </h3>
          <p className="text-sm mt-1 mb-6 line-clamp-2" style={{ color: 'var(--sp-ink-dim)' }}>
            {track.description}
          </p>

          {/* 进度条：hover 加粗 + accent 播放头 */}
          <div
            className="mb-5"
            onMouseEnter={() => setProgressHover(true)}
            onMouseLeave={() => setProgressHover(false)}
          >
            <div className="relative h-5 flex items-center">
              <div
                className="absolute inset-x-0 top-1/2 transition-all duration-150"
                style={{
                  transform: 'translateY(-50%)',
                  background: 'var(--sp-line)',
                  height: progressHover ? 4 : 1,
                }}
              />
              <div
                className="absolute left-0 top-1/2 transition-all duration-150"
                style={{
                  transform: 'translateY(-50%)',
                  width: `${progress}%`,
                  background: 'var(--sp-accent)',
                  height: progressHover ? 4 : 1,
                }}
              />
              <div
                className="absolute rounded-full transition-transform duration-150"
                style={{
                  width: progressHover ? 12 : 10,
                  height: progressHover ? 12 : 10,
                  left: `${progress}%`,
                  top: '50%',
                  transform: `translate(-50%,-50%) scale(${progressHover ? 1.2 : 1})`,
                  background: 'var(--sp-accent)',
                  boxShadow: progressHover ? '0 0 0 4px rgba(var(--sp-accent),0.2)' : 'none',
                }}
              />
              <input
                type="range"
                min={0}
                max={duration || 100}
                value={currentTime}
                onChange={handleSeek}
                className="absolute inset-0 w-full opacity-0 cursor-pointer"
                aria-label="播放进度"
              />
            </div>
            <div className="flex justify-between font-mono text-[11px] mt-1.5" style={{ color: 'var(--sp-ink-dim)' }}>
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          {/* 播放控制 */}
          <div className="flex items-center justify-center gap-3">
            {/* 音量 */}
            <div className="flex items-center gap-1.5 group">
              <button
                onClick={() => setMuted(!muted)}
                className="p-1.5 rounded-sm transition-colors"
                style={{ color: muted || volume === 0 ? 'var(--sp-ink-ghost)' : 'var(--sp-ink-dim)' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--sp-accent)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = muted || volume === 0 ? 'var(--sp-ink-ghost)' : 'var(--sp-ink-dim)')}
                title={muted ? '取消静音' : '静音'}
              >
                {muted || volume === 0 ? (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M16.5 12A4.5 4.5 0 0014 8.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  </svg>
                ) : volume < 0.5 ? (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M7 9v6h4l5 5V4l-5 5H7z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 8.03v7.94c1.48-.73 2.5-2.25 2.5-4.97zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  </svg>
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setVolume(v);
                  if (v > 0) setMuted(false);
                }}
                className="w-16 h-1 appearance-none cursor-pointer rounded-full"
                style={{
                  background: `linear-gradient(to right, var(--sp-accent) 0%, var(--sp-accent) ${(muted ? 0 : volume) * 100}%, var(--sp-line) ${(muted ? 0 : volume) * 100}%, var(--sp-line) 100%)`,
                  accentColor: 'var(--sp-accent)',
                }}
                aria-label="音量"
              />
            </div>

            {/* 后退 10s */}
            <button
              className="h-9 px-3 rounded-sm flex items-center gap-1.5 transition-colors"
              style={{ border: '1px solid var(--sp-line)', color: 'var(--sp-ink-dim)' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--sp-accent)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--sp-ink-dim)')}
              onClick={() => {
                if (audioRef.current) { audioRef.current.currentTime = Math.max(0, currentTime - 10); }
              }}
              title="后退 10 秒"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
              </svg>
              <span className="font-mono text-[10px]">10s</span>
            </button>

            {/* 播放/暂停 */}
            <button
              onClick={togglePlay}
              className="w-14 h-14 rounded-full flex items-center justify-center transition-transform hover:-translate-y-0.5"
              style={{ background: 'var(--sp-accent)', color: '#14120E' }}
            >
              {loading ? (
                <svg className="w-6 h-6 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : isPlaying ? (
                <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              ) : (
                <svg className="w-7 h-7 ml-1" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            {/* 前进 10s */}
            <button
              className="h-9 px-3 rounded-sm flex items-center gap-1.5 transition-colors"
              style={{ border: '1px solid var(--sp-line)', color: 'var(--sp-ink-dim)' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--sp-accent)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--sp-ink-dim)')}
              onClick={() => {
                if (audioRef.current) { audioRef.current.currentTime = Math.min(duration, currentTime + 10); }
              }}
              title="前进 10 秒"
            >
              <span className="font-mono text-[10px]">10s</span>
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M16 18h2V6h-2zm-8.5-6L16 6v12z" />
              </svg>
            </button>

            {/* 倍速 */}
            <button
              className="h-9 px-3 rounded-sm flex items-center gap-1 transition-colors font-mono text-xs"
              style={{
                border: '1px solid var(--sp-line)',
                color: playbackRate !== 1 ? 'var(--sp-accent)' : 'var(--sp-ink-dim)',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--sp-accent)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = playbackRate !== 1 ? 'var(--sp-accent)' : 'var(--sp-ink-dim)')}
              onClick={() => {
                const idx = PLAYBACK_RATES.indexOf(playbackRate);
                const next = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
                setPlaybackRate(next);
              }}
              title="点击切换倍速"
            >
              {playbackRate}x
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
