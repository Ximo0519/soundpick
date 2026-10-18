// Shared API types — single source of truth for frontend ↔ backend contracts.

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

export interface MusicTrack {
  id: string;
  title: string;
  description: string;
  audioUrl: string;
  style: string;
  mood: string;
  duration: number;
  prompt: string;
  sunoId?: string | null;
  createdAt: string;
}

export interface GenerateMusicRequest {
  prompt: string;
  style: string;
  duration: number;
  mood: string;
}

export interface GenerateMusicResponse {
  id: string;
  title: string;
  description: string;
  audioUrl: string;
  style: string;
  mood: string;
  duration: number;
  prompt: string;
  createdAt: string;
}

export interface ChatRequest {
  message: string;
  systemPrompt?: string;
}
