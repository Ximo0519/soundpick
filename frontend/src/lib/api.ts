/**
 * 前端统一 API 客户端
 * - 自动携带 JWT Token
 * - 统一响应解包与错误抛出
 */

const BASE_URL = import.meta.env.VITE_API_URL || '';

const TOKEN_KEY = 'aimusic_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const resp = await fetch(`${BASE_URL}${path}`, { ...options, headers });

  let body: { success?: boolean; data?: T; error?: string } = {};
  try {
    body = await resp.json();
  } catch {
    // 非 JSON 响应
  }

  if (!resp.ok || body.success === false) {
    if (resp.status === 401) {
      // Token 失效，清除并让上层跳转登录
      setToken(null);
    }
    throw new ApiError(resp.status, body.error || `请求失败 (${resp.status})`);
  }

  return body.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: data !== undefined ? JSON.stringify(data) : undefined,
    }),
  patch: <T>(path: string, data: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ============ 类型定义 ============

export interface User {
  id: number;
  username: string;
  quotaRemaining: number;
  createdAt?: string;
}

export interface MusicRecord {
  id: string;
  title: string;
  description: string;
  prompt: string;
  optimizedPrompt?: string | null;
  tags: string;
  mood: string;
  instrumental: boolean;
  duration?: number | null;
  status: 'generating' | 'completed' | 'failed';
  failReason?: string | null;
  audioUrl?: string | null;
  generationGroup?: string | null;
  sunoId?: string | null;
  createdAt: string;
}

export interface SharePost {
  id: string;
  userId: number;
  authorName: string;
  musicId: string | null;
  title: string;
  description: string;
  promptText: string;
  audioUrl: string | null;
  likesCount: number;
  playsCount: number;
  likedByMe: boolean;
  createdAt: string;
}

// ============ 业务 API ============

export const authApi = {
  register: (username: string, password: string, activationCode: string) =>
    api.post<{ token: string; user: User }>('/api/auth/register', {
      username,
      password,
      activationCode,
    }),
  login: (username: string, password: string) =>
    api.post<{ token: string; user: User }>('/api/auth/login', {
      username,
      password,
    }),
  me: () => api.get<User>('/api/auth/me'),
};

export const musicApi = {
  generate: (payload: {
    prompt?: string;
    style?: string;
    mood?: string;
    instrumental?: boolean;
    taskType?: 'extend' | 'cover';
    referenceClipId?: string;
  }) =>
    api.post<{
      groupId: string;
      versions: MusicRecord[];
      quotaRemaining: number;
      polishFailed: boolean;
    }>('/api/music/generate', payload),
  groupQuery: (groupId: string) =>
    api.get<MusicRecord[]>(`/api/music/group/${groupId}`),
  list: () =>
    isDevPreview()
      ? Promise.resolve([...MOCK_MUSIC])
      : api.get<MusicRecord[]>('/api/music'),
  detail: (id: string) => api.get<MusicRecord>(`/api/music/${id}`),
  rename: (id: string, title: string) =>
    api.patch<MusicRecord>(`/api/music/${id}`, { title }),
  remove: (id: string) => api.delete<{ id: string }>(`/api/music/${id}`),
  downloadUrl: (id: string) =>
    api.get<{ url: string }>(`/api/music/${id}/download`),
};

export const plazaApi = {
  list: () =>
    isDevPreview()
      ? Promise.resolve([...MOCK_SHARES])
      : api.get<SharePost[]>('/api/plaza'),
  create: (payload: {
    musicId?: string;
    title?: string;
    description?: string;
    promptText?: string;
  }) => api.post<SharePost>('/api/plaza', payload),
  like: (id: string) =>
    api.post<{ liked: boolean; likesCount: number }>(`/api/plaza/${id}/like`),
  play: (id: string) => api.post<null>(`/api/plaza/${id}/play`),
};

export const aiApi = {
  optimizePrompt: (payload: {
    prompt: string;
    style?: string;
    mood?: string;
  }) =>
    api.post<{ title: string; sunoPrompt: string; tags: string }>(
      '/api/ai/optimize-prompt',
      payload,
    ),
};

// ============ 开发预览模式（无后端时查看内页，生产构建被 Vite 剔除） ============

export function isDevPreview(): boolean {
  return (
    import.meta.env.DEV &&
    localStorage.getItem('aimusic_dev_preview') === '1'
  );
}

export const MOCK_USER: User = {
  id: 1,
  username: 'demo_user',
  quotaRemaining: 7,
  createdAt: new Date().toISOString(),
};

const MOCK_MUSIC: MusicRecord[] = [
  {
    id: 'mock-1',
    title: '午夜咖啡馆',
    description: '慵懒的爵士钢琴配上柔和的刷鼓，适合深夜独处',
    prompt: '一段轻松的爵士风格，适合午后咖啡馆，带有萨克斯风旋律',
    optimizedPrompt: 'Smooth jazz, cafe ambiance, saxophone lead, brush drums, 90 BPM',
    tags: 'jazz',
    mood: 'calm',
    instrumental: false,
    duration: 127,
    status: 'completed',
    audioUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
  },
  {
    id: 'mock-2',
    title: '霓虹街道',
    description: '合成器浪潮，雨夜城市的霓虹灯光',
    prompt: '赛博朋克风格的电子音乐，像雨夜开车穿过霓虹城市',
    optimizedPrompt: 'Synthwave, retro-futuristic, night drive, neon city, analog synths',
    tags: 'electronic',
    mood: 'energetic',
    instrumental: true,
    duration: 184,
    status: 'completed',
    audioUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
  },
  {
    id: 'mock-3',
    title: '山间清晨',
    description: '',
    prompt: '民谣吉他指弹，清晨山林的鸟鸣和溪流',
    tags: 'folk',
    mood: 'happy',
    instrumental: true,
    status: 'generating',
    createdAt: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
  },
  {
    id: 'mock-4',
    title: '未完成的交响曲',
    description: '',
    prompt: '宏大的管弦乐，电影预告片风格',
    tags: 'classical',
    mood: 'sad',
    instrumental: true,
    status: 'failed',
    failReason: 'Suno 服务繁忙，请稍后重试',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
  },
];

const MOCK_SHARES: SharePost[] = [
  {
    id: 'share-1',
    userId: 2,
    authorName: '音乐老饕',
    musicId: 'mock-9',
    title: '午夜咖啡馆',
    description: '用「爵士+萨克斯+咖啡馆」生成的，氛围感拉满，已经循环一晚上了',
    promptText: 'Smooth jazz, cafe ambiance, saxophone lead, brush drums, 90 BPM',
    audioUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    likesCount: 23,
    playsCount: 156,
    likedByMe: false,
    createdAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
  },
  {
    id: 'share-2',
    userId: 3,
    authorName: 'Synth骑士',
    musicId: null,
    title: '万能赛博朋克提示词',
    description: '这个提示词配方试了十几次都很稳，拿走不谢',
    promptText: 'Synthwave, retro-futuristic, night drive, neon city lights, analog synthesizers, 100 BPM, cinematic',
    audioUrl: null,
    likesCount: 47,
    playsCount: 0,
    likedByMe: true,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
  },
  {
    id: 'share-3',
    userId: 4,
    authorName: '林间漫步',
    musicId: 'mock-10',
    title: '山间清晨',
    description: '指弹吉他+自然环境音，当工作背景音绝了',
    promptText: 'Acoustic fingerstyle guitar, morning forest, birds chirping, stream sounds, peaceful',
    audioUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
    likesCount: 12,
    playsCount: 89,
    likedByMe: false,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 20).toISOString(),
  },
];
