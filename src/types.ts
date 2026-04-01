export interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  lastSeen: string;
}

export interface Server {
  id: string;
  name: string;
  ownerId: string;
  iconURL?: string;
  createdAt: string;
}

export interface Channel {
  id: string;
  serverId: string;
  name: string;
  type: 'text' | 'voice';
  createdAt: string;
}

export interface Message {
  id: string;
  channelId: string;
  serverId: string;
  authorId: string;
  authorName: string;
  authorPhoto: string;
  content: string;
  timestamp: any;
  isAI?: boolean;
}
