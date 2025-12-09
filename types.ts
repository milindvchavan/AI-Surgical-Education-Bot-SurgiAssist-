export interface Agent {
  id: string;
  name: string;
  role: string;
  description: string;
  voiceName: string; // Gemini voice name
  avatarUrl: string;
  style: 'serious' | 'cheerful';
  systemInstructionAddon: string;
}

export interface Message {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: Date;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
