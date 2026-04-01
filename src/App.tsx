import React, { useState, useEffect, useRef } from 'react';
import { auth, db, loginWithGoogle, logout, OperationType, handleFirestoreError } from './firebase';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { collection, onSnapshot, query, orderBy, addDoc, serverTimestamp, doc, setDoc, getDocs, where, deleteDoc, updateDoc } from 'firebase/firestore';
import { Hash, Volume2, Plus, Settings, LogOut, MessageSquare, Send, Sparkles, User, Video, Mic, MicOff, VideoOff, PhoneOff, Users, UserPlus, Check, X, Search, Mail, Globe, Shield, Lock, Loader2 } from 'lucide-react';
import { cn } from './lib/utils';
import { format } from 'date-fns';
import { askAI, summarizeConversation } from './services/geminiService';
import type { Server, Channel, Message, UserProfile, FriendRequest, Friendship, ServerMember, DirectMessage } from './types';
import Markdown from 'react-markdown';
import { io } from 'socket.io-client';

import { AnimatePresence, motion } from 'motion/react';

const socket = io();

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [started, setStarted] = useState(false);
  const [activeServer, setActiveServer] = useState<Server | null>(null);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [activeDM, setActiveDM] = useState<UserProfile | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [dmMessages, setDmMessages] = useState<DirectMessage[]>([]);
  const [isAIThinking, setIsAIThinking] = useState(false);
  
  // Voice Participants State
  const [voiceParticipants, setVoiceParticipants] = useState<{ [channelId: string]: UserProfile[] }>({});
  
  // Friends State
  const [friends, setFriends] = useState<Friendship[]>([]);
  const [friendRequests, setFriendRequests] = useState<FriendRequest[]>([]);
  const [showFriendsView, setShowFriendsView] = useState(false);
  const [searchEmail, setSearchEmail] = useState('');
  const [searchResults, setSearchResults] = useState<UserProfile[]>([]);
  
  // Modal States
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [showInviteFriends, setShowInviteFriends] = useState(false);
  const [friendsFilter, setFriendsFilter] = useState<'online' | 'all' | 'pending'>('all');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setLoading(false);
      if (u) {
        // Create/Update user profile for searchability
        try {
          await setDoc(doc(db, 'users', u.uid), {
            uid: u.uid,
            displayName: u.displayName,
            email: u.email,
            photoURL: u.photoURL,
            lastSeen: serverTimestamp()
          }, { merge: true });
        } catch (err) {
          console.error('Profile update error:', err);
        }
      }
    });
    return unsubscribe;
  }, []);

  // Fetch Servers (where user is a member)
  useEffect(() => {
    if (!user) return;
    // In a real app, we'd query servers where user is a member.
    // For simplicity, we'll fetch all servers but in production you'd use a collectionGroup or a members subcollection check.
    const q = query(collection(db, 'servers'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const s = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Server));
      setServers(s);
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'servers'));
    return unsubscribe;
  }, [user]);

  // Fetch Friends
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, `users/${user.uid}/friends`));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setFriends(snapshot.docs.map(doc => doc.data() as Friendship));
    });
    return unsubscribe;
  }, [user]);

  // Fetch Friend Requests
  useEffect(() => {
    if (!user) return;
    // Fetch both incoming and outgoing requests
    const q = query(collection(db, `users/${user.uid}/friendRequests`));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setFriendRequests(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as FriendRequest)));
    });
    return unsubscribe;
  }, [user]);

  // Fetch Channels
  useEffect(() => {
    if (!user || !activeServer) {
      setChannels([]);
      return;
    }
    const q = query(collection(db, `servers/${activeServer.id}/channels`), orderBy('createdAt', 'asc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const c = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Channel));
      setChannels(c);
      if (c.length > 0 && !activeChannel) {
        setActiveChannel(c[0]);
      }
    }, (err) => handleFirestoreError(err, OperationType.LIST, `servers/${activeServer.id}/channels`));
    return unsubscribe;
  }, [user, activeServer]);

  // Fetch Messages
  useEffect(() => {
    if (!user || !activeServer || !activeChannel || activeChannel.type !== 'text') {
      setMessages([]);
      return;
    }
    const q = query(
      collection(db, `servers/${activeServer.id}/channels/${activeChannel.id}/messages`),
      orderBy('timestamp', 'asc')
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const m = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Message));
      setMessages(m);
    }, (err) => handleFirestoreError(err, OperationType.LIST, `servers/${activeServer.id}/channels/${activeChannel.id}/messages`));
    return unsubscribe;
  }, [user, activeServer, activeChannel]);

  // Fetch Server Members
  const [serverMembers, setServerMembers] = useState<UserProfile[]>([]);
  useEffect(() => {
    if (!activeServer) {
      setServerMembers([]);
      return;
    }
    const q = query(collection(db, `servers/${activeServer.id}/members`));
    const unsubscribe = onSnapshot(q, async (snapshot) => {
      const memberIds = snapshot.docs.map(doc => doc.id);
      if (memberIds.length === 0) {
        setServerMembers([]);
        return;
      }
      
      // Fetch user profiles for these members
      const usersQ = query(collection(db, 'users'), where('uid', 'in', memberIds));
      const usersSnapshot = await getDocs(usersQ);
      setServerMembers(usersSnapshot.docs.map(doc => doc.data() as UserProfile));
    });
    return unsubscribe;
  }, [activeServer]);

  // Fetch DM Messages
  useEffect(() => {
    if (!user || !activeDM) {
      setDmMessages([]);
      return;
    }
    const chatId = [user.uid, activeDM.uid].sort().join('_');
    const q = query(
      collection(db, `direct_messages/${chatId}/messages`),
      orderBy('timestamp', 'asc')
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const m = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as DirectMessage));
      setDmMessages(m);
    }, (err) => handleFirestoreError(err, OperationType.LIST, `direct_messages/${chatId}/messages`));
    return unsubscribe;
  }, [user, activeDM]);

  // Global Voice Participants Listener
  useEffect(() => {
    if (!user || !activeServer) return;
    
    const unsubscribes: (() => void)[] = [];
    
    channels.filter(c => c.type === 'voice').forEach(channel => {
      const q = collection(db, `servers/${activeServer.id}/channels/${channel.id}/participants`);
      const unsub = onSnapshot(q, (snapshot) => {
        const participants = snapshot.docs.map(doc => doc.data() as UserProfile);
        setVoiceParticipants(prev => ({ ...prev, [channel.id]: participants }));
      });
      unsubscribes.push(unsub);
    });

    return () => unsubscribes.forEach(unsub => unsub());
  }, [user, activeServer, channels]);

  const handleSendMessage = async (content: string) => {
    if (!user || !activeServer || !activeChannel || !content.trim()) return;
    
    const messageData = {
      channelId: activeChannel.id,
      serverId: activeServer.id,
      authorId: user.uid,
      authorName: user.displayName || 'Anonymous',
      authorPhoto: user.photoURL || '',
      content: content.trim(),
      timestamp: serverTimestamp(),
      isAI: false
    };

    try {
      await addDoc(collection(db, `servers/${activeServer.id}/channels/${activeChannel.id}/messages`), messageData);
      
      // AI Trigger
      if (content.toLowerCase().startsWith('@ai')) {
        setIsAIThinking(true);
        const prompt = content.slice(3).trim();
        const aiResponse = await askAI(prompt, messages.slice(-5).map(m => `${m.authorName}: ${m.content}`).join('\n'));
        
        await addDoc(collection(db, `servers/${activeServer.id}/channels/${activeChannel.id}/messages`), {
          channelId: activeChannel.id,
          serverId: activeServer.id,
          authorId: 'ai-assistant',
          authorName: 'Cyberse AI',
          authorPhoto: 'https://api.dicebear.com/7.x/bottts/svg?seed=Cyberse',
          content: aiResponse,
          timestamp: serverTimestamp(),
          isAI: true
        });
        setIsAIThinking(false);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `servers/${activeServer.id}/channels/${activeChannel.id}/messages`);
    }
  };

  const handleSendDM = async (content: string) => {
    if (!user || !activeDM || !content.trim()) return;
    
    const chatId = [user.uid, activeDM.uid].sort().join('_');
    const messageData = {
      chatId,
      authorId: user.uid,
      authorName: user.displayName,
      authorPhoto: user.photoURL,
      content: content.trim(),
      timestamp: serverTimestamp()
    };

    try {
      await addDoc(collection(db, `direct_messages/${chatId}/messages`), messageData);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `direct_messages/${chatId}/messages`);
    }
  };

  const handleSummarize = async () => {
    if (!activeServer || !activeChannel || messages.length === 0) return;
    setIsAIThinking(true);
    const summary = await summarizeConversation(messages.map(m => `${m.authorName}: ${m.content}`));
    
    await addDoc(collection(db, `servers/${activeServer.id}/channels/${activeChannel.id}/messages`), {
      channelId: activeChannel.id,
      serverId: activeServer.id,
      authorId: 'ai-assistant',
      authorName: 'Cyberse AI (Summary)',
      authorPhoto: 'https://api.dicebear.com/7.x/bottts/svg?seed=Cyberse',
      content: summary,
      timestamp: serverTimestamp(),
      isAI: true
    });
    setIsAIThinking(false);
  };

  const searchUsers = async (email: string) => {
    if (!email.trim()) return;
    try {
      const q = query(collection(db, 'users'), where('email', '==', email.trim()));
      const snapshot = await getDocs(q);
      setSearchResults(snapshot.docs.map(doc => doc.data() as UserProfile).filter(u => u.uid !== user?.uid));
    } catch (err) {
      console.error('Search error:', err);
    }
  };

  const sendFriendRequest = async (targetUser: UserProfile) => {
    if (!user) return;
    try {
      const requestId = `${user.uid}_${targetUser.uid}`;
      const requestData: FriendRequest = {
        id: requestId,
        fromId: user.uid,
        fromName: user.displayName || 'Anonymous',
        fromPhoto: user.photoURL || '',
        toId: targetUser.uid,
        status: 'pending',
        timestamp: serverTimestamp()
      };
      // Add to both users' requests
      await setDoc(doc(db, `users/${targetUser.uid}/friendRequests`, requestId), requestData);
      await setDoc(doc(db, `users/${user.uid}/friendRequests`, requestId), requestData);
      alert('Friend request sent!');
    } catch (err) {
      console.error('Friend request error:', err);
    }
  };

  const acceptFriendRequest = async (request: FriendRequest) => {
    if (!user) return;
    console.log('Accepting friend request:', request.id);
    try {
      // 1. Update request status in both places FIRST to satisfy security rules
      await setDoc(doc(db, `users/${user.uid}/friendRequests`, request.id), { status: 'accepted' }, { merge: true });
      await setDoc(doc(db, `users/${request.fromId}/friendRequests`, request.id), { status: 'accepted' }, { merge: true });
      
      // 2. Add to current user's friends
      await setDoc(doc(db, `users/${user.uid}/friends`, request.fromId), {
        friendId: request.fromId,
        friendName: request.fromName,
        friendPhoto: request.fromPhoto,
        createdAt: new Date().toISOString()
      });
      
      // 3. Add to other user's friends
      await setDoc(doc(db, `users/${request.fromId}/friends`, user.uid), {
        friendId: user.uid,
        friendName: user.displayName || 'Anonymous',
        friendPhoto: user.photoURL || '',
        createdAt: new Date().toISOString()
      });
      console.log('Friend request accepted successfully');
    } catch (err) {
      console.error('Accept friend error:', err);
      alert('Failed to accept friend request. Please try again.');
    }
  };

  const rejectFriendRequest = async (request: FriendRequest) => {
    if (!user) return;
    console.log('Rejecting friend request:', request.id);
    try {
      await setDoc(doc(db, `users/${user.uid}/friendRequests`, request.id), { status: 'declined' }, { merge: true });
      await setDoc(doc(db, `users/${request.fromId}/friendRequests`, request.id), { status: 'declined' }, { merge: true });
      console.log('Friend request rejected successfully');
    } catch (err) {
      console.error('Reject friend error:', err);
    }
  };

  const inviteToChannel = async (friend: Friendship) => {
    if (!activeServer) return;
    try {
      await setDoc(doc(db, `servers/${activeServer.id}/members`, friend.friendId), {
        uid: friend.friendId,
        role: 'member',
        joinedAt: new Date().toISOString()
      });
      alert(`Invited ${friend.friendName} to ${activeServer.name}`);
    } catch (err) {
      console.error('Invite error:', err);
    }
  };

  const addMemberByEmail = async () => {
    if (!activeServer) return;
    const email = prompt('Enter user email to add to server:');
    if (!email) return;
    try {
      const q = query(collection(db, 'users'), where('email', '==', email.trim()));
      const snapshot = await getDocs(q);
      if (snapshot.empty) {
        alert('User not found');
        return;
      }
      const targetUser = snapshot.docs[0].data() as UserProfile;
      await setDoc(doc(db, `servers/${activeServer.id}/members`, targetUser.uid), {
        uid: targetUser.uid,
        role: 'member',
        joinedAt: new Date().toISOString()
      });
      alert(`Added ${targetUser.displayName} to ${activeServer.name}`);
    } catch (err) {
      console.error('Add member error:', err);
    }
  };

  const createServer = async (name: string, image: string) => {
    if (!user || !name.trim()) return;
    try {
      const serverRef = doc(collection(db, 'servers'));
      const serverData: Server = {
        id: serverRef.id,
        name: name.trim(),
        image: image.trim() || `https://api.dicebear.com/7.x/initials/svg?seed=${name}`,
        ownerId: user.uid,
        createdAt: new Date().toISOString()
      };
      await setDoc(serverRef, serverData);
      
      // Add creator as owner member
      await setDoc(doc(db, `servers/${serverRef.id}/members`, user.uid), {
        uid: user.uid,
        displayName: user.displayName,
        photoURL: user.photoURL,
        role: 'owner',
        joinedAt: new Date().toISOString()
      });

      // Create default general channel
      const channelRef = doc(collection(db, `servers/${serverRef.id}/channels`));
      await setDoc(channelRef, {
        id: channelRef.id,
        serverId: serverRef.id,
        name: 'general',
        type: 'text',
        createdAt: new Date().toISOString()
      });

      setActiveServer(serverData);
      setShowFriendsView(false);
      setShowCreateServer(false);
    } catch (err) {
      console.error('Create server error:', err);
    }
  };

  const createChannel = async (name: string, type: 'text' | 'voice') => {
    if (!activeServer || !name.trim()) return;
    try {
      const channelRef = doc(collection(db, `servers/${activeServer.id}/channels`));
      await setDoc(channelRef, {
        id: channelRef.id,
        serverId: activeServer.id,
        name: name.trim().toLowerCase().replace(/\s+/g, '-'),
        type,
        createdAt: new Date().toISOString()
      });
      setShowCreateChannel(false);
    } catch (err) {
      console.error('Create channel error:', err);
    }
  };

  if (loading) return <div className="h-screen w-full flex items-center justify-center bg-cyberse-bg text-white">Loading...</div>;

  if (!user) {
    return (
      <div className="h-screen w-full overflow-y-auto scroll-smooth bg-cyberse-bg cyberse-grid">
        {!started && <HeroSection onGetStarted={() => setStarted(true)} />}
        <div id="login-section" className="h-screen w-full flex items-center justify-center">
          <LoginScreen onLogin={loginWithGoogle} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-full flex overflow-hidden bg-cyberse-bg cyberse-grid">
      {/* Server Sidebar */}
      <div className="w-[72px] bg-cyberse-sidebar flex flex-col items-center py-3 gap-2 flex-shrink-0 border-r border-white/5">
        <ServerIcon 
          name="Friends" 
          active={showFriendsView} 
          onClick={() => {
            setShowFriendsView(true);
            setActiveServer(null);
          }} 
          icon={<Users size={28} />}
          className={showFriendsView ? "bg-cyberse-glow text-cyberse-bg" : ""}
          badge={friendRequests.filter(r => r.status === 'pending' && r.toId === user.uid).length}
        />
        <div className="w-8 h-[2px] bg-white/10 rounded-full my-1" />
        {servers.map(server => (
          <ServerIcon 
            key={server.id}
            name={server.name}
            active={activeServer?.id === server.id && !showFriendsView}
            onClick={() => {
              setActiveServer(server);
              setShowFriendsView(false);
            }}
            image={server.image}
          />
        ))}
        <ServerIcon 
          name="Add Server" 
          onClick={() => setShowCreateServer(true)} 
          icon={<Plus size={28} />}
          className="text-cyberse-glow hover:bg-cyberse-glow hover:text-cyberse-bg"
        />
      </div>

      {/* Channel Sidebar */}
      <div className="w-60 bg-cyberse-dark/40 backdrop-blur-xl flex flex-col flex-shrink-0 border-r border-white/5">
        <div className="h-12 px-4 flex items-center justify-between border-b border-white/5 shadow-sm">
          <h1 className="font-bold truncate text-white">{showFriendsView ? 'Friends' : (activeServer?.name || 'Direct Messages')}</h1>
        </div>
        
        <div className="flex-1 overflow-y-auto p-2 space-y-4">
          {showFriendsView ? (
            <div className="space-y-2">
              <button 
                onClick={() => {
                  setActiveServer(null);
                  setActiveChannel(null);
                  setActiveDM(null);
                }} 
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all group",
                  (!activeServer && !activeDM) ? "bg-cyberse-glow/10 text-white shadow-[inset_0_0_10px_rgba(0,242,255,0.1)] border border-cyberse-glow/20" : "text-cyberse-muted hover:bg-white/5 hover:text-white"
                )}
              >
                <Users size={20} className={(!activeServer && !activeDM) ? "text-cyberse-glow" : "group-hover:text-cyberse-glow transition-colors"} />
                <span className="font-medium text-sm">Friends</span>
              </button>
              <button 
                onClick={() => setShowAddFriend(true)} 
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-cyberse-muted hover:bg-white/5 hover:text-white transition-all group"
              >
                <UserPlus size={20} className="group-hover:text-cyberse-glow transition-colors" />
                <span className="font-medium text-sm">Add Friend</span>
              </button>
            </div>
          ) : activeServer && (
            <>
              <div>
                <div className="flex items-center justify-between px-2 mb-1 group">
                  <span className="text-[10px] font-bold text-cyberse-muted uppercase tracking-widest">Channels</span>
                  <button onClick={() => setShowCreateChannel(true)} className="text-cyberse-muted hover:text-cyberse-glow transition-colors" title="Create Channel">
                    <Plus size={14} />
                  </button>
                </div>
                <div className="space-y-0.5">
                  {channels.map(channel => (
                    <ChannelItem 
                      key={channel.id}
                      channel={channel}
                      active={activeChannel?.id === channel.id}
                      onClick={() => {
                        setActiveChannel(channel);
                        setActiveDM(null);
                      }}
                      participants={voiceParticipants[channel.id] || []}
                    />
                  ))}
                </div>
              </div>
              
              <div className="mt-6">
                <div className="flex items-center justify-between px-2 mb-2 group">
                  <span className="text-[10px] font-bold text-cyberse-muted uppercase tracking-widest">Members — {serverMembers.length}</span>
                  <button onClick={() => setShowInviteFriends(true)} className="text-cyberse-muted hover:text-cyberse-glow transition-colors" title="Invite Friends">
                    <UserPlus size={14} />
                  </button>
                </div>
                <div className="space-y-1">
                  {serverMembers.map(member => (
                    <div key={member.uid} className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-white/5 transition-all cursor-default group">
                      <div className="relative">
                        <img src={member.photoURL} className="w-7 h-7 rounded-lg border border-white/10" />
                        <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-cyberse-glow border-2 border-cyberse-dark rounded-full shadow-[0_0_5px_rgba(0,242,255,0.5)]" />
                      </div>
                      <span className="text-sm text-cyberse-muted group-hover:text-white truncate transition-colors">{member.displayName}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* User Info */}
        <div className="h-14 bg-cyberse-dark/60 backdrop-blur-md px-2 flex items-center gap-2 border-t border-white/5">
          <div className="relative">
            <img src={user.photoURL || ''} className="w-8 h-8 rounded-xl border border-white/10" referrerPolicy="no-referrer" />
            <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-cyberse-glow border-2 border-cyberse-bg rounded-full shadow-[0_0_5px_rgba(0,242,255,0.5)]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold truncate leading-tight text-white">{user.displayName}</p>
            <p className="text-xs text-cyberse-muted truncate tracking-tighter">ID: {user.uid.slice(0, 8)}</p>
          </div>
          <button onClick={logout} className="p-2 text-cyberse-muted hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all" title="Logout">
            <LogOut size={18} />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 bg-cyberse-bg/50 backdrop-blur-sm flex flex-col min-w-0">
        <AnimatePresence mode="wait">
          {showFriendsView ? (
            <motion.div 
              key="friends-view"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 flex flex-col"
            >
              <div className="h-12 px-4 flex items-center justify-between border-b border-white/5 shadow-sm">
                <div className="flex items-center gap-2">
                  <Users size={24} className="text-cyberse-glow" />
                  <h2 className="font-bold text-white">Friends</h2>
                </div>
                <div className="flex gap-4 text-sm font-medium">
                  <button 
                    onClick={() => setFriendsFilter('online')}
                    className={cn(friendsFilter === 'online' ? "text-cyberse-glow" : "text-cyberse-muted hover:text-white transition-colors")}
                  >
                    Online
                  </button>
                  <button 
                    onClick={() => setFriendsFilter('all')}
                    className={cn(friendsFilter === 'all' ? "text-cyberse-glow" : "text-cyberse-muted hover:text-white transition-colors")}
                  >
                    All
                  </button>
                  <button 
                    onClick={() => setFriendsFilter('pending')}
                    className={cn(friendsFilter === 'pending' ? "text-cyberse-glow" : "text-cyberse-muted hover:text-white transition-colors")}
                  >
                    Pending
                    {friendRequests.filter(r => r.status === 'pending' && r.toId === user.uid).length > 0 && (
                      <span className="ml-1 bg-cyberse-link text-white text-[10px] px-1.5 rounded-full font-bold">
                        {friendRequests.filter(r => r.status === 'pending' && r.toId === user.uid).length}
                      </span>
                    )}
                  </button>
                  <button 
                    onClick={() => setShowAddFriend(true)}
                    className="bg-cyberse-glow text-cyberse-bg px-3 py-1 rounded-lg font-bold hover:scale-105 active:scale-95 transition-all shadow-[0_0_10px_rgba(0,242,255,0.3)]"
                  >
                    Add Friend
                  </button>
                </div>
              </div>
              
              <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
                {friendsFilter === 'pending' ? (
                  <section>
                    <h3 className="text-xs font-bold text-cyberse-muted uppercase tracking-widest mb-4">Pending Requests</h3>
                    <div className="space-y-2">
                      {friendRequests.filter(r => r.status === 'pending').map(req => (
                        <div key={req.id} className="bg-cyberse-dark/40 border border-white/5 p-3 rounded-xl flex items-center justify-between group hover:bg-white/5 transition-all">
                          <div className="flex items-center gap-3">
                            <img 
                              src={req.fromId === user.uid ? 'https://api.dicebear.com/7.x/initials/svg?seed=' + req.toId : req.fromPhoto} 
                              className="w-10 h-10 rounded-xl border border-white/10" 
                              referrerPolicy="no-referrer"
                            />
                            <div>
                              <p className="font-bold text-white">
                                {req.fromId === user.uid ? `Request to ${req.toId.substring(0, 8)}` : req.fromName}
                              </p>
                              <p className="text-xs text-cyberse-muted">
                                {req.fromId === user.uid ? 'Outgoing Friend Request' : 'Incoming Friend Request'}
                              </p>
                            </div>
                          </div>
                          <div className="flex gap-2 relative z-10">
                            {req.fromId !== user.uid ? (
                              <>
                                <button 
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    acceptFriendRequest(req);
                                  }}
                                  className="bg-cyberse-glow w-10 h-10 flex items-center justify-center rounded-xl hover:scale-110 active:scale-95 transition-all text-cyberse-bg shadow-[0_0_15px_rgba(0,242,255,0.3)] cursor-pointer"
                                  aria-label="Accept"
                                >
                                  <Check size={22} strokeWidth={3} />
                                </button>
                                <button 
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    rejectFriendRequest(req);
                                  }}
                                  className="bg-red-500/20 hover:bg-red-500 w-10 h-10 flex items-center justify-center rounded-xl hover:scale-110 active:scale-95 transition-all text-red-500 hover:text-white border border-red-500/30 hover:border-red-500 shadow-lg cursor-pointer"
                                  aria-label="Decline"
                                >
                                  <X size={22} strokeWidth={3} />
                                </button>
                              </>
                            ) : (
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  rejectFriendRequest(req);
                                }}
                                className="p-2 text-cyberse-muted hover:text-red-500 transition-all cursor-pointer"
                                aria-label="Cancel Request"
                              >
                                <X size={20} />
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                      {friendRequests.filter(r => r.status === 'pending').length === 0 && (
                        <p className="text-center py-8 text-cyberse-muted italic">No pending requests.</p>
                      )}
                    </div>
                  </section>
                ) : (
                  <section>
                    <h3 className="text-xs font-bold text-cyberse-muted uppercase tracking-widest mb-4">
                      {friendsFilter === 'online' ? 'Online Friends' : 'All Friends'} — {friends.length}
                    </h3>
                    <div className="space-y-2">
                      {friends.map(friend => (
                        <div 
                          key={friend.friendId} 
                          onClick={() => setActiveDM({ uid: friend.friendId, displayName: friend.friendName, photoURL: friend.friendPhoto } as UserProfile)}
                          className="bg-cyberse-dark/40 border border-white/5 p-3 rounded-xl flex items-center justify-between group hover:bg-white/5 transition-all cursor-pointer"
                        >
                          <div className="flex items-center gap-3">
                            <div className="relative">
                              <img src={friend.friendPhoto} className="w-10 h-10 rounded-xl border border-white/10" referrerPolicy="no-referrer" />
                              <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-cyberse-glow border-2 border-cyberse-bg rounded-full shadow-[0_0_5px_rgba(0,242,255,0.5)]" />
                            </div>
                            <p className="font-bold text-white">{friend.friendName}</p>
                          </div>
                          <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveDM({ uid: friend.friendId, displayName: friend.friendName, photoURL: friend.friendPhoto } as UserProfile);
                              }}
                              className="p-2 bg-white/5 rounded-lg text-cyberse-muted hover:text-cyberse-glow hover:bg-white/10 transition-all"
                            >
                              <MessageSquare size={20} />
                            </button>
                            <button className="p-2 bg-white/5 rounded-lg text-cyberse-muted hover:text-cyberse-glow hover:bg-white/10 transition-all">
                              <Settings size={20} />
                            </button>
                          </div>
                        </div>
                      ))}
                      {friends.length === 0 && (
                        <div className="text-center py-8 text-cyberse-muted">
                          <p>No friends found. Start by searching for users!</p>
                        </div>
                      )}
                    </div>
                  </section>
                )}
              </div>
            </motion.div>
          ) : activeDM ? (
            <motion.div 
              key={activeDM.uid}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="flex-1 flex flex-col min-h-0"
            >
              <PrivateChat 
                friend={activeDM} 
                messages={dmMessages} 
                onSendMessage={handleSendDM} 
              />
            </motion.div>
          ) : activeChannel ? (
            <motion.div 
              key={activeChannel.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="flex-1 flex flex-col min-h-0"
            >
              <div className="h-12 px-4 flex items-center justify-between border-b border-white/5 shadow-sm">
                <div className="flex items-center gap-2">
                  {activeChannel.type === 'text' ? <Hash size={24} className="text-cyberse-muted" /> : <Volume2 size={24} className="text-cyberse-muted" />}
                  <h2 className="font-bold text-white">{activeChannel.name}</h2>
                </div>
                <div className="flex items-center gap-4 text-cyberse-muted">
                  <InviteDropdown friends={friends} onInvite={inviteToChannel} />
                  {activeChannel.type === 'text' && (
                    <button onClick={handleSummarize} className="hover:text-cyberse-glow flex items-center gap-1 text-sm font-medium transition-colors">
                      <Sparkles size={18} />
                      Summarize
                    </button>
                  )}
                  <Settings size={20} className="hover:text-cyberse-glow cursor-pointer transition-colors" />
                </div>
              </div>

              {activeChannel.type === 'text' ? (
                <ChatWindow 
                  messages={messages} 
                  onSendMessage={handleSendMessage} 
                  isAIThinking={isAIThinking}
                />
              ) : (
                <VoiceCall channel={activeChannel} user={user} serverId={activeServer.id} />
              )}
            </motion.div>
          ) : (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex-1 flex flex-col items-center justify-center text-cyberse-muted p-8 text-center"
            >
              <div className="w-24 h-24 bg-cyberse-dark/40 border border-cyberse-glow/30 rounded-3xl flex items-center justify-center mb-6 cyberse-hex shadow-[0_0_20px_rgba(0,242,255,0.2)]">
                <MessageSquare size={48} className="text-cyberse-glow" />
              </div>
              <h2 className="text-3xl font-bold text-white mb-2">Welcome to Cyberse Link</h2>
              <p className="max-w-md text-cyberse-muted">Select a server and channel to start communicating. Use @ai to talk to the assistant!</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Modals */}
      <CreateServerModal 
        isOpen={showCreateServer} 
        onClose={() => setShowCreateServer(false)} 
        onCreate={createServer} 
      />
      <CreateChannelModal 
        isOpen={showCreateChannel} 
        onClose={() => setShowCreateChannel(false)} 
        onCreate={createChannel} 
      />
      <AddFriendModal 
        isOpen={showAddFriend} 
        onClose={() => setShowAddFriend(false)} 
        onSearch={searchUsers}
        searchResults={searchResults}
        onAdd={sendFriendRequest}
      />
      <InviteFriendsModal 
        isOpen={showInviteFriends} 
        onClose={() => setShowInviteFriends(false)} 
        friends={friends}
        onInvite={inviteToChannel}
      />
    </div>
  );
}

function InviteFriendsModal({ isOpen, onClose, friends, onInvite }: any) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Invite Friends to Server">
      <p className="text-cyberse-muted mb-6">Select friends to invite them to this server.</p>
      <div className="space-y-2 max-h-80 overflow-y-auto custom-scrollbar">
        {friends.map((friend: Friendship) => (
          <div key={friend.friendId} className="bg-cyberse-dark/40 border border-white/5 p-3 rounded-xl flex items-center justify-between group hover:bg-white/5 transition-all">
            <div className="flex items-center gap-3">
              <img src={friend.friendPhoto} className="w-10 h-10 rounded-xl border border-white/10 group-hover:border-cyberse-glow transition-all" referrerPolicy="no-referrer" />
              <div>
                <p className="font-bold text-white">{friend.friendName}</p>
                <p className="text-xs text-cyberse-muted">Friend</p>
              </div>
            </div>
            <button 
              onClick={() => {
                onInvite(friend);
                onClose();
              }}
              className="bg-cyberse-glow text-cyberse-bg px-4 py-1.5 rounded-lg text-sm font-bold hover:scale-105 active:scale-95 transition-all shadow-[0_0_10px_rgba(0,242,255,0.3)]"
            >
              Invite
            </button>
          </div>
        ))}
        {friends.length === 0 && (
          <div className="text-center py-8 text-cyberse-muted">
            <p>No friends to invite. Add some friends first!</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function InviteDropdown({ friends, onInvite }: { friends: Friendship[], onInvite: (f: Friendship) => void }) {
  const [open, setOpen] = useState(false);
  
  return (
    <div className="relative">
      <button 
        onClick={() => setOpen(!open)}
        className="bg-cyberse-glow text-cyberse-bg text-xs font-bold px-3 py-1 rounded-lg hover:scale-105 transition-all shadow-[0_0_10px_rgba(0,242,255,0.3)]"
      >
        Invite
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-56 bg-cyberse-dark/90 backdrop-blur-xl rounded-xl shadow-2xl border border-white/10 p-2 z-50">
          <p className="text-[10px] font-bold text-cyberse-muted px-2 mb-2 uppercase tracking-widest">Invite Friends</p>
          <div className="max-h-48 overflow-y-auto space-y-1 custom-scrollbar">
            {friends.map(friend => (
              <button 
                key={friend.friendId}
                onClick={() => {
                  onInvite(friend);
                  setOpen(false);
                }}
                className="w-full flex items-center gap-2 p-2 hover:bg-white/5 rounded-lg transition-colors text-left group"
              >
                <img src={friend.friendPhoto} className="w-6 h-6 rounded-lg border border-white/10 group-hover:border-cyberse-glow transition-all" />
                <span className="text-sm truncate text-white group-hover:text-cyberse-glow transition-colors">{friend.friendName}</span>
              </button>
            ))}
            {friends.length === 0 && <p className="text-[10px] text-cyberse-muted p-2 italic">No friends to invite.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function HeroSection({ onGetStarted }: { onGetStarted: () => void }) {
  return (
    <div className="h-screen w-full flex flex-col items-center justify-center relative overflow-hidden px-4">
      {/* Animated Background Elements */}
      <div className="absolute inset-0 cyberse-grid opacity-20" />
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-cyberse-glow/10 rounded-full blur-[128px] animate-pulse" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-cyberse-purple/10 rounded-full blur-[128px] animate-pulse delay-700" />
      
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        className="relative z-10 text-center max-w-4xl"
      >
        <div className="flex justify-center mb-8">
          <div className="w-24 h-24 bg-cyberse-dark border-2 border-cyberse-glow rounded-3xl flex items-center justify-center shadow-[0_0_30px_rgba(0,242,255,0.3)] cyberse-hex">
            <Sparkles size={48} className="text-cyberse-glow" />
          </div>
        </div>
        
        <h1 className="text-6xl md:text-8xl font-black mb-6 tracking-tighter text-white">
          CYBERSE <span className="text-cyberse-glow">LINK</span>
        </h1>
        
        <p className="text-xl md:text-2xl text-cyberse-muted mb-12 leading-relaxed font-medium">
          The next generation AI communication platform. <br className="hidden md:block" />
          Connect, collaborate, and evolve in the digital frontier.
        </p>
        
        <div className="flex flex-col md:flex-row items-center justify-center gap-6">
          <button 
            onClick={() => {
              onGetStarted();
              document.getElementById('login-section')?.scrollIntoView({ behavior: 'smooth' });
            }}
            className="group relative px-8 py-4 bg-cyberse-glow text-cyberse-bg font-bold rounded-xl overflow-hidden transition-all hover:scale-105 active:scale-95 shadow-[0_0_20px_rgba(0,242,255,0.4)]"
          >
            <div className="absolute inset-0 bg-white/20 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-500" />
            <span className="relative flex items-center gap-2 text-lg">
              GET STARTED <Check size={20} />
            </span>
          </button>
          
          <button className="px-8 py-4 bg-white/5 hover:bg-white/10 text-white font-bold rounded-xl border border-white/10 backdrop-blur-md transition-all">
            LEARN MORE
          </button>
        </div>
      </motion.div>
      
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.5, duration: 1 }}
        className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 text-cyberse-muted"
      >
        <span className="text-xs font-bold tracking-widest uppercase">Scroll to Explore</span>
        <div className="w-[1px] h-12 bg-gradient-to-b from-cyberse-glow to-transparent" />
      </motion.div>
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="w-full max-w-md p-1">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true }}
        className="bg-cyberse-dark/40 backdrop-blur-2xl p-8 rounded-3xl border border-white/10 shadow-2xl text-center relative overflow-hidden"
      >
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-cyberse-glow to-transparent opacity-50" />
        
        <div className="w-20 h-20 bg-cyberse-darker border border-cyberse-glow/30 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg relative z-10">
          <Sparkles size={40} className="text-cyberse-glow animate-pulse" />
        </div>
        
        <h2 className="text-3xl font-bold mb-2 text-white">Welcome Back</h2>
        <p className="text-cyberse-muted mb-8">Access the Cyberse Link network</p>
        
        <button 
          onClick={onLogin}
          className="w-full bg-white text-cyberse-bg hover:bg-cyberse-glow transition-all font-bold py-4 px-6 rounded-xl flex items-center justify-center gap-3 group shadow-xl"
        >
          <img src="https://www.google.com/favicon.ico" className="w-5 h-5 bg-white rounded-full p-0.5" />
          <span>Continue with Google</span>
          <div className="w-0 group-hover:w-4 overflow-hidden transition-all duration-300">
            <Check size={16} />
          </div>
        </button>
        
        <div className="mt-8 pt-8 border-t border-white/5 flex justify-center gap-6">
          <div className="flex flex-col items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-cyberse-glow shadow-[0_0_8px_rgba(0,242,255,0.8)]" />
            <span className="text-[10px] font-bold text-cyberse-muted uppercase tracking-tighter">Secure</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-cyberse-purple shadow-[0_0_8px_rgba(157,78,221,0.8)]" />
            <span className="text-[10px] font-bold text-cyberse-muted uppercase tracking-tighter">AI Ready</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-cyberse-link shadow-[0_0_8px_rgba(255,77,0,0.8)]" />
            <span className="text-[10px] font-bold text-cyberse-muted uppercase tracking-tighter">Global</span>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function ServerIcon({ name, active, onClick, icon, image, className, badge }: any) {
  return (
    <div className="relative group flex items-center justify-center w-full">
      <div className={cn(
        "absolute left-0 w-1 bg-cyberse-glow rounded-r-full transition-all duration-200",
        active ? "h-10" : "h-2 group-hover:h-5 opacity-0 group-hover:opacity-100"
      )} />
      <button 
        onClick={onClick}
        title={name}
        className={cn(
          "w-12 h-12 flex items-center justify-center transition-all duration-200 overflow-hidden relative",
          active ? "rounded-[16px] bg-cyberse-glow text-cyberse-bg shadow-[0_0_15px_rgba(0,242,255,0.4)]" : "rounded-[24px] bg-cyberse-dark hover:rounded-[16px] hover:bg-cyberse-glow text-cyberse-text hover:text-cyberse-bg",
          className
        )}
      >
        {image ? <img src={image} className="w-full h-full object-cover" /> : icon || name[0]}
        {badge > 0 && (
          <div className="absolute -bottom-1 -right-1 bg-cyberse-link text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center border-2 border-cyberse-bg shadow-lg">
            {badge}
          </div>
        )}
      </button>
    </div>
  );
}

function ChannelItem({ channel, active, onClick, participants = [] }: any) {
  return (
    <div className="space-y-1">
      <button 
        onClick={onClick}
        className={cn(
          "w-full flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all group relative overflow-hidden",
          active 
            ? "bg-cyberse-glow/10 text-white shadow-[inset_0_0_10px_rgba(0,242,255,0.1)]" 
            : "text-cyberse-muted hover:bg-white/5 hover:text-white"
        )}
      >
        {active && <div className="absolute left-0 top-0 bottom-0 w-1 bg-cyberse-glow shadow-[0_0_10px_rgba(0,242,255,0.5)]" />}
        {channel.type === 'text' ? (
          <Hash size={18} className={cn("transition-colors", active ? "text-cyberse-glow" : "text-cyberse-muted group-hover:text-white")} />
        ) : (
          <Volume2 size={18} className={cn("transition-colors", active ? "text-cyberse-glow" : "text-cyberse-muted group-hover:text-white")} />
        )}
        <span className="font-medium truncate text-sm">{channel.name}</span>
        {active && <div className="ml-auto w-1.5 h-1.5 bg-cyberse-glow rounded-full shadow-[0_0_5px_rgba(0,242,255,0.5)]" />}
      </button>
      
      {channel.type === 'voice' && participants.length > 0 && (
        <div className="ml-6 space-y-1 pb-1">
          {participants.map((p: any) => (
            <div key={p.uid} className="flex items-center gap-2 px-2 py-0.5 rounded hover:bg-white/5 transition-all group">
              <img src={p.photoURL} className="w-4 h-4 rounded border border-white/10" />
              <span className="text-xs text-cyberse-muted group-hover:text-white truncate">{p.displayName}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PrivateChat({ friend, messages, onSendMessage }: any) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    onSendMessage(input);
    setInput('');
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-cyberse-bg/50 backdrop-blur-sm">
      <div className="h-12 px-4 flex items-center justify-between border-b border-white/5 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="relative">
            <img src={friend.photoURL || friend.friendPhoto} className="w-8 h-8 rounded-xl border border-white/10" />
            <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-cyberse-glow border-2 border-cyberse-bg rounded-full shadow-[0_0_5px_rgba(0,242,255,0.5)]" />
          </div>
          <h2 className="font-bold text-white">{friend.displayName || friend.friendName}</h2>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-6 scrollbar-hide">
        {messages.map((msg: DirectMessage) => (
          <div key={msg.id} className="flex gap-4 group animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs text-cyberse-muted">
                  {msg.timestamp?.toDate ? format(msg.timestamp.toDate(), 'HH:mm') : 'Just now'}
                </span>
              </div>
              <div className="text-cyberse-text leading-relaxed break-words markdown-body">
                <Markdown>{msg.content}</Markdown>
              </div>
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="p-4">
        <div className="bg-cyberse-dark/60 backdrop-blur-md rounded-2xl px-4 py-2 flex items-center gap-3 border border-white/10 shadow-lg focus-within:border-cyberse-glow/50 transition-all">
          <input 
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Message @${friend.displayName || friend.friendName}`}
            className="flex-1 bg-transparent border-none outline-none text-white placeholder:text-cyberse-muted py-2"
          />
          <button type="submit" className="text-cyberse-glow hover:scale-110 active:scale-95 disabled:opacity-50 transition-all" disabled={!input.trim()}>
            <Send size={20} />
          </button>
        </div>
      </form>
    </div>
  );
}

function ChatWindow({ messages, onSendMessage, isAIThinking }: any) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isAIThinking]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    onSendMessage(input);
    setInput('');
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-cyberse-bg/50 backdrop-blur-sm">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-6 scrollbar-hide">
        {messages.map((msg: Message) => (
          <div key={msg.id} className="flex gap-4 group animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="relative">
              <img src={msg.authorPhoto} className="w-10 h-10 rounded-xl flex-shrink-0 mt-0.5 border border-white/10" referrerPolicy="no-referrer" />
              {msg.isAI && <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-cyberse-glow rounded-full border-2 border-cyberse-bg shadow-[0_0_10px_rgba(0,242,255,0.5)]" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className={cn("font-bold hover:text-cyberse-glow transition-colors cursor-pointer", msg.isAI ? "text-cyberse-glow" : "text-white")}>
                  {msg.authorName}
                </span>
                {msg.isAI && <span className="bg-cyberse-glow/20 text-cyberse-glow text-[10px] px-1.5 py-0.5 rounded border border-cyberse-glow/30 font-bold uppercase tracking-wider">AI</span>}
                <span className="text-xs text-cyberse-muted">
                  {msg.timestamp?.toDate ? format(msg.timestamp.toDate(), 'HH:mm') : 'Just now'}
                </span>
              </div>
              <div className="text-cyberse-text leading-relaxed break-words markdown-body">
                <Markdown>{msg.content}</Markdown>
              </div>
            </div>
          </div>
        ))}
        {isAIThinking && (
          <div className="flex gap-4 animate-pulse">
            <div className="w-10 h-10 rounded-xl bg-white/5 border border-white/10" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-24 bg-white/5 rounded" />
              <div className="h-4 w-full bg-white/5 rounded" />
            </div>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="p-4">
        <div className="bg-cyberse-dark/60 backdrop-blur-md rounded-2xl px-4 py-2 flex items-center gap-3 border border-white/10 shadow-lg focus-within:border-cyberse-glow/50 transition-all">
          <button type="button" className="text-cyberse-muted hover:text-cyberse-glow transition-colors">
            <Plus size={24} />
          </button>
          <input 
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type @ai to ask the assistant..."
            className="flex-1 bg-transparent border-none outline-none text-white placeholder:text-cyberse-muted py-2"
          />
          <div className="flex items-center gap-3 text-cyberse-muted">
            <button type="button" className="hover:text-cyberse-glow transition-colors"><Sparkles size={20} /></button>
            <button type="submit" className="text-cyberse-glow hover:scale-110 active:scale-95 disabled:opacity-50 transition-all" disabled={!input.trim()}>
              <Send size={20} />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function VoiceCall({ channel, user, serverId }: any) {
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOn, setIsVideoOn] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [participants, setParticipants] = useState<any[]>([]);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnections = useRef<{ [key: string]: RTCPeerConnection }>({});
  const remoteStreams = useRef<{ [key: string]: MediaStream }>({});
  const [remoteStreamsState, setRemoteStreamsState] = useState<{ [key: string]: MediaStream }>({});

  useEffect(() => {
    if (!inCall || !user || !serverId || !channel) return;

    const participantRef = doc(db, `servers/${serverId}/channels/${channel.id}/participants`, user.uid);
    
    const joinVoice = async () => {
      try {
        await setDoc(participantRef, {
          uid: user.uid,
          displayName: user.displayName,
          photoURL: user.photoURL,
          joinedAt: serverTimestamp()
        });
      } catch (err) {
        console.error("Error joining voice room:", err);
      }
    };

    joinVoice();

    return () => {
      deleteDoc(participantRef).catch(console.error);
    };
  }, [inCall, user, serverId, channel]);

  useEffect(() => {
    if (!inCall) return;

    const startLocalStream = async () => {
      try {
        console.log("Requesting media devices...");
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: true
        }).catch(async (err) => {
          console.warn("Could not get video, falling back to audio only:", err);
          return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        });
        
        console.log("Local stream obtained:", stream.id);
        localStreamRef.current = stream;
        stream.getAudioTracks().forEach(t => t.enabled = !isMuted);
        stream.getVideoTracks().forEach(t => t.enabled = isVideoOn);
        
        setRemoteStreamsState(prev => ({ ...prev, [user.uid]: stream }));

        // Join room ONLY after local stream is ready
        const roomId = `${serverId}-${channel.id}`;
        socket.emit("join-room", roomId, user.uid);
      } catch (err) {
        console.error("Error accessing media devices:", err);
        alert("Could not access microphone or camera. Please check your permissions.");
      }
    };

    if (inCall) {
      startLocalStream();
    }

    const createPeerConnection = (targetSocketId: string, targetUserId: string) => {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
      });

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("ice-candidate", {
            target: targetSocketId,
            candidate: event.candidate
          });
        }
      };

      pc.ontrack = (event) => {
        console.log(`Received remote track from ${targetUserId}:`, event.track.kind);
        const stream = event.streams[0];
        if (stream) {
          remoteStreams.current[targetUserId] = stream;
          setRemoteStreamsState(prev => ({ ...prev, [targetUserId]: stream }));
        }
      };

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => {
          pc.addTrack(track, localStreamRef.current!);
        });
      }

      peerConnections.current[targetSocketId] = pc;
      return pc;
    };

    socket.on("user-joined", async (userId, socketId) => {
      const pc = createPeerConnection(socketId, userId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("offer", { target: socketId, offer, fromUserId: user.uid });
    });

    socket.on("offer", async (payload) => {
      const pc = createPeerConnection(payload.from, payload.fromUserId);
      await pc.setRemoteDescription(new RTCSessionDescription(payload.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("answer", { target: payload.from, answer });
    });

    socket.on("answer", async (payload) => {
      const pc = peerConnections.current[payload.from];
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.answer));
      }
    });

    socket.on("ice-candidate", async (payload) => {
      const pc = peerConnections.current[payload.from];
      if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      }
    });

    // Firestore presence
    const participantRef = doc(db, `servers/${serverId}/channels/${channel.id}/participants`, user.uid);
    setDoc(participantRef, {
      uid: user.uid,
      displayName: user.displayName,
      photoURL: user.photoURL,
      joinedAt: serverTimestamp()
    });

    const q = query(collection(db, `servers/${serverId}/channels/${channel.id}/participants`));
    const unsubFirestore = onSnapshot(q, (snapshot) => {
      setParticipants(snapshot.docs.map(doc => doc.data()));
    });

    return () => {
      socket.off("user-joined");
      socket.off("offer");
      socket.off("answer");
      socket.off("ice-candidate");
      
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }
      
      Object.values(peerConnections.current).forEach(pc => pc.close());
      deleteDoc(participantRef).catch(console.error);
      unsubFirestore();
    };
  }, [inCall, channel.id, serverId, user.uid]);

  useEffect(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(t => t.enabled = !isMuted);
    }
  }, [isMuted]);

  useEffect(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach(t => t.enabled = isVideoOn);
    }
  }, [isVideoOn]);

  return (
    <div className="flex-1 flex flex-col bg-cyberse-bg p-4 cyberse-grid">
      {!inCall ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <div className="w-24 h-24 bg-cyberse-dark border border-cyberse-glow/30 rounded-3xl flex items-center justify-center mb-6 shadow-[0_0_20px_rgba(0,242,255,0.2)] cyberse-hex">
            <Volume2 size={40} className="text-cyberse-glow animate-pulse" />
          </div>
          <h2 className="text-3xl font-bold mb-2 text-white">Voice Channel: {channel.name}</h2>
          <p className="text-cyberse-muted mb-8 max-w-sm">Hop into the call to chat with others in real-time using voice and video.</p>
          <button 
            onClick={() => setInCall(true)}
            className="bg-cyberse-glow hover:scale-105 active:scale-95 text-cyberse-bg font-bold py-3 px-12 rounded-xl transition-all shadow-[0_0_15px_rgba(0,242,255,0.4)]"
          >
            Join Call
          </button>
        </div>
      ) : (
        <div className="flex-1 flex flex-col">
          <div className="flex-1 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4 overflow-y-auto">
            {participants.map(p => (
              <VideoParticipant 
                key={p.uid} 
                participant={p} 
                stream={remoteStreamsState[p.uid]} 
                isLocal={p.uid === user.uid}
              />
            ))}
            
            {participants.length === 1 && (
              <div className="bg-cyberse-dark/40 backdrop-blur-md rounded-2xl flex flex-col items-center justify-center relative overflow-hidden aspect-video border border-dashed border-white/10 opacity-50">
                <div className="w-20 h-20 bg-white/5 rounded-full flex items-center justify-center mb-4">
                  <User size={40} className="text-cyberse-muted" />
                </div>
                <div className="absolute bottom-4 left-4 bg-black/50 px-3 py-1 rounded text-sm font-bold text-white">
                  Waiting for others...
                </div>
              </div>
            )}
          </div>

          {/* Call Controls */}
          <div className="h-24 flex items-center justify-center gap-6">
            <button 
              onClick={() => setIsMuted(!isMuted)}
              className={cn(
                "w-14 h-14 rounded-2xl flex items-center justify-center transition-all border border-white/10 shadow-lg",
                isMuted ? "bg-red-500/20 text-red-500 border-red-500/50" : "bg-cyberse-dark text-white hover:bg-cyberse-glow hover:text-cyberse-bg"
              )}
            >
              {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
            </button>
            <button 
              onClick={() => setIsVideoOn(!isVideoOn)}
              className={cn(
                "w-14 h-14 rounded-2xl flex items-center justify-center transition-all border border-white/10 shadow-lg",
                !isVideoOn ? "bg-red-500/20 text-red-500 border-red-500/50" : "bg-cyberse-dark text-white hover:bg-cyberse-glow hover:text-cyberse-bg"
              )}
            >
              {!isVideoOn ? <VideoOff size={24} /> : <Video size={24} />}
            </button>
            <button 
              onClick={() => setInCall(false)}
              className="w-14 h-14 rounded-2xl bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-all shadow-[0_0_15px_rgba(239,68,68,0.4)]"
            >
              <PhoneOff size={24} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Modal({ isOpen, onClose, title, children }: any) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0 }} 
        animate={{ opacity: 1 }} 
        onClick={onClose}
        className="absolute inset-0 bg-cyberse-bg/80 backdrop-blur-md" 
      />
      <motion.div 
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="relative bg-cyberse-dark/90 backdrop-blur-2xl w-full max-w-md rounded-3xl border border-white/10 shadow-2xl overflow-hidden"
      >
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-cyberse-glow to-transparent opacity-50" />
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold text-white">{title}</h2>
            <button onClick={onClose} className="text-cyberse-muted hover:text-white transition-colors">
              <X size={24} />
            </button>
          </div>
          {children}
        </div>
      </motion.div>
    </div>
  );
}

function CreateServerModal({ isOpen, onClose, onCreate }: any) {
  const [name, setName] = useState('');
  const [image, setImage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    setLoading(true);
    await onCreate(name, image);
    setLoading(false);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Initialize New Server">
      <p className="text-cyberse-muted mb-6">Give your new server a personality with a name and an icon. You can always change it later.</p>
      <div className="space-y-4">
        <div className="flex flex-col items-center mb-6">
          <div className="w-24 h-24 bg-white/5 rounded-3xl border-2 border-dashed border-white/10 flex flex-col items-center justify-center text-cyberse-muted cursor-pointer hover:border-cyberse-glow hover:text-cyberse-glow transition-all relative overflow-hidden group cyberse-hex">
            {image ? <img src={image} className="w-full h-full object-cover" /> : (
              <>
                <Plus size={32} className="group-hover:scale-110 transition-transform" />
                <span className="text-[10px] font-bold uppercase tracking-widest mt-1">Upload</span>
              </>
            )}
          </div>
        </div>
        <div>
          <label className="text-xs font-bold text-cyberse-muted uppercase mb-2 block tracking-widest">Server Name</label>
          <input 
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter server name"
            className="w-full bg-cyberse-bg/50 border border-white/10 p-3 rounded-xl text-white outline-none focus:border-cyberse-glow/50 focus:ring-1 focus:ring-cyberse-glow/20 transition-all"
          />
        </div>
        <div>
          <label className="text-xs font-bold text-cyberse-muted uppercase mb-2 block tracking-widest">Icon URL (Optional)</label>
          <input 
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="https://example.com/icon.png"
            className="w-full bg-cyberse-bg/50 border border-white/10 p-3 rounded-xl text-white outline-none focus:border-cyberse-glow/50 focus:ring-1 focus:ring-cyberse-glow/20 transition-all"
          />
        </div>
        <div className="pt-4">
          <button 
            onClick={handleCreate}
            disabled={!name.trim() || loading}
            className="w-full bg-cyberse-glow text-cyberse-bg font-bold py-3 rounded-xl hover:scale-105 active:scale-95 disabled:opacity-50 transition-all shadow-[0_0_15px_rgba(0,242,255,0.3)]"
          >
            {loading ? 'INITIALIZING...' : 'CREATE SERVER'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CreateChannelModal({ isOpen, onClose, onCreate }: any) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'text' | 'voice'>('text');
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    setLoading(true);
    await onCreate(name, type);
    setLoading(false);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create Channel">
      <div className="space-y-6">
        <div>
          <label className="text-[10px] font-bold text-cyberse-muted uppercase mb-3 block tracking-widest">Channel Type</label>
          <div className="space-y-2">
            <button 
              onClick={() => setType('text')}
              className={cn(
                "w-full flex items-center gap-3 p-4 rounded-xl transition-all border group",
                type === 'text' ? "bg-cyberse-glow/10 border-cyberse-glow shadow-[0_0_15px_rgba(0,242,255,0.1)]" : "bg-white/5 border-transparent hover:bg-white/10"
              )}
            >
              <div className={cn("p-2 rounded-lg transition-colors", type === 'text' ? "bg-cyberse-glow text-cyberse-bg" : "bg-white/10 text-cyberse-muted group-hover:text-white")}>
                <Hash size={24} />
              </div>
              <div className="text-left">
                <p className="font-bold text-white">Text</p>
                <p className="text-xs text-cyberse-muted">Send messages, images, and GIFs.</p>
              </div>
              {type === 'text' && <div className="ml-auto w-5 h-5 bg-cyberse-glow text-cyberse-bg rounded-full flex items-center justify-center shadow-[0_0_10px_rgba(0,242,255,0.5)]"><Check size={14} /></div>}
            </button>
            <button 
              onClick={() => setType('voice')}
              className={cn(
                "w-full flex items-center gap-3 p-4 rounded-xl transition-all border group",
                type === 'voice' ? "bg-cyberse-glow/10 border-cyberse-glow shadow-[0_0_15px_rgba(0,242,255,0.1)]" : "bg-white/5 border-transparent hover:bg-white/10"
              )}
            >
              <div className={cn("p-2 rounded-lg transition-colors", type === 'voice' ? "bg-cyberse-glow text-cyberse-bg" : "bg-white/10 text-cyberse-muted group-hover:text-white")}>
                <Volume2 size={24} />
              </div>
              <div className="text-left">
                <p className="font-bold text-white">Voice</p>
                <p className="text-xs text-cyberse-muted">Hang out with voice, video, and screen share.</p>
              </div>
              {type === 'voice' && <div className="ml-auto w-5 h-5 bg-cyberse-glow text-cyberse-bg rounded-full flex items-center justify-center shadow-[0_0_10px_rgba(0,242,255,0.5)]"><Check size={14} /></div>}
            </button>
          </div>
        </div>
        <div>
          <label className="text-[10px] font-bold text-cyberse-muted uppercase mb-2 block tracking-widest">Channel Name</label>
          <div className="relative">
            <div className="absolute left-4 top-1/2 -translate-y-1/2 text-cyberse-muted">
              {type === 'text' ? <Hash size={18} /> : <Volume2 size={18} />}
            </div>
            <input 
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="new-channel"
              className="w-full bg-white/5 border border-white/10 p-3 pl-12 rounded-xl text-white outline-none focus:border-cyberse-glow focus:ring-1 focus:ring-cyberse-glow transition-all placeholder:text-white/20"
            />
          </div>
        </div>
      </div>
      <div className="mt-8 flex justify-end gap-4">
        <button onClick={onClose} className="px-6 py-2 text-cyberse-muted hover:text-white transition-colors">Cancel</button>
        <button 
          onClick={handleCreate}
          disabled={!name.trim() || loading}
          className="bg-cyberse-glow text-cyberse-bg font-bold px-8 py-2 rounded-xl hover:scale-105 active:scale-95 transition-all disabled:opacity-50 shadow-[0_0_15px_rgba(0,242,255,0.3)]"
        >
          {loading ? 'Creating...' : 'Create Channel'}
        </button>
      </div>
    </Modal>
  );
}

function AddFriendModal({ isOpen, onClose, onSearch, searchResults, onAdd }: any) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSearch = async () => {
    setLoading(true);
    await onSearch(email);
    setLoading(false);
  };

  const handleAdd = async (user: UserProfile) => {
    setLoading(true);
    await onAdd(user);
    setLoading(false);
    setSuccess(true);
    setTimeout(() => {
      setSuccess(false);
      onClose();
    }, 2000);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Friend">
      {success ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <div className="w-20 h-20 bg-cyberse-glow text-cyberse-bg rounded-3xl flex items-center justify-center mb-6 cyberse-hex shadow-[0_0_20px_rgba(0,242,255,0.4)]">
            <Check size={40} />
          </div>
          <h3 className="text-2xl font-bold text-white mb-2">Friend Request Sent!</h3>
          <p className="text-cyberse-muted">We've sent a request to that user.</p>
        </div>
      ) : (
        <>
          <p className="text-cyberse-muted mb-6">You can add friends with their email address.</p>
          <div className="relative mb-8">
            <input 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Enter an email address"
              className="w-full bg-white/5 border border-white/10 p-4 rounded-xl text-white outline-none focus:border-cyberse-glow focus:ring-1 focus:ring-cyberse-glow transition-all placeholder:text-white/20"
            />
            <button 
              onClick={handleSearch}
              disabled={loading || !email.trim()}
              className="absolute right-2 top-1/2 -translate-y-1/2 bg-cyberse-glow text-cyberse-bg px-5 py-2 rounded-lg text-sm font-bold hover:scale-105 active:scale-95 transition-all disabled:opacity-50 shadow-[0_0_10px_rgba(0,242,255,0.3)]"
            >
              {loading ? 'Searching...' : 'Search'}
            </button>
          </div>
          
          <div className="space-y-2 max-h-60 overflow-y-auto custom-scrollbar">
            {searchResults.map((res: UserProfile) => (
              <div key={res.uid} className="bg-cyberse-dark/40 border border-white/5 p-3 rounded-xl flex items-center justify-between group hover:bg-white/5 transition-all">
                <div className="flex items-center gap-3">
                  <img src={res.photoURL} className="w-10 h-10 rounded-xl border border-white/10 group-hover:border-cyberse-glow transition-all" referrerPolicy="no-referrer" />
                  <div>
                    <p className="font-bold text-white">{res.displayName}</p>
                    <p className="text-xs text-cyberse-muted">{res.email}</p>
                  </div>
                </div>
                <button 
                  onClick={() => handleAdd(res)}
                  disabled={loading}
                  className="bg-cyberse-glow p-2 rounded-lg hover:scale-110 transition-all text-cyberse-bg shadow-lg disabled:opacity-50"
                >
                  <UserPlus size={20} />
                </button>
              </div>
            ))}
            {searchResults.length === 0 && email && !loading && (
              <p className="text-center py-4 text-cyberse-muted text-sm italic">No users found with that email.</p>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

function VideoParticipant({ participant, stream, isLocal }: any) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasVideo, setHasVideo] = useState(false);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      
      const checkVideo = () => {
        const videoTracks = stream.getVideoTracks();
        setHasVideo(videoTracks.length > 0 && videoTracks.some((t: any) => t.enabled));
      };

      checkVideo();
      stream.onaddtrack = checkVideo;
      stream.onremovetrack = checkVideo;
      
      // Also check periodically as tracks might be enabled/disabled
      const interval = setInterval(checkVideo, 1000);
      return () => {
        clearInterval(interval);
        stream.onaddtrack = null;
        stream.onremovetrack = null;
      };
    }
  }, [stream]);

  return (
    <div 
      className={cn(
        "bg-cyberse-dark/60 backdrop-blur-md rounded-3xl flex flex-col items-center justify-center relative overflow-hidden aspect-video transition-all group border",
        isLocal ? "border-cyberse-glow shadow-[0_0_20px_rgba(0,242,255,0.2)]" : "border-white/5 hover:border-cyberse-glow/30"
      )}
    >
      {stream && hasVideo ? (
        <video 
          ref={videoRef} 
          autoPlay 
          playsInline 
          muted={isLocal}
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="flex flex-col items-center animate-in fade-in zoom-in duration-300">
          <div className="relative">
            <img src={participant.photoURL} className="w-24 h-24 rounded-2xl mb-4 shadow-2xl border-2 border-white/10" referrerPolicy="no-referrer" />
            {!stream && (
              <div className="absolute inset-0 flex items-center justify-center bg-cyberse-bg/60 rounded-2xl backdrop-blur-sm">
                <Loader2 className="text-cyberse-glow animate-spin" size={32} />
              </div>
            )}
          </div>
          {!stream && <p className="text-[10px] text-cyberse-muted font-bold tracking-[0.2em] uppercase">Connecting...</p>}
          {stream && !hasVideo && <p className="text-[10px] text-cyberse-muted font-bold tracking-[0.2em] uppercase">Video Off</p>}
        </div>
      )}
      <div className="absolute bottom-4 left-4 bg-cyberse-bg/80 backdrop-blur-xl px-3 py-1.5 rounded-xl text-sm font-bold flex items-center gap-2 border border-white/10 shadow-xl">
        <div className={cn("w-2 h-2 rounded-full shadow-[0_0_5px_currentColor]", stream ? "bg-cyberse-glow text-cyberse-glow" : "bg-cyberse-muted text-cyberse-muted animate-pulse")} />
        <span className="truncate max-w-[120px] text-white">{participant.displayName} {isLocal && "(You)"}</span>
      </div>
    </div>
  );
}
