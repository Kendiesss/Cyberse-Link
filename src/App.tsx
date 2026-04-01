import React, { useState, useEffect, useRef } from 'react';
import { auth, db, loginWithGoogle, logout, OperationType, handleFirestoreError } from './firebase';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { collection, onSnapshot, query, orderBy, addDoc, serverTimestamp, doc, setDoc, getDocs, where, deleteDoc, updateDoc } from 'firebase/firestore';
import { Hash, Volume2, Plus, Settings, LogOut, MessageSquare, Send, Sparkles, User, Video, Mic, MicOff, VideoOff, PhoneOff, Users, UserPlus, Check, X, Search, Mail, Globe, Shield, Lock, Loader2 } from 'lucide-react';
import { cn } from './lib/utils';
import { format } from 'date-fns';
import { askAI, summarizeConversation } from './services/geminiService';
import type { Server, Channel, Message, UserProfile, FriendRequest, Friendship, ServerMember } from './types';
import Markdown from 'react-markdown';
import { io } from 'socket.io-client';

import { AnimatePresence, motion } from 'motion/react';

const socket = io();

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeServer, setActiveServer] = useState<Server | null>(null);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isAIThinking, setIsAIThinking] = useState(false);
  
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
    try {
      // Add to current user's friends
      await setDoc(doc(db, `users/${user.uid}/friends`, request.fromId), {
        friendId: request.fromId,
        friendName: request.fromName,
        friendPhoto: request.fromPhoto,
        createdAt: new Date().toISOString()
      });
      // Add to other user's friends (allowed by new rules)
      await setDoc(doc(db, `users/${request.fromId}/friends`, user.uid), {
        friendId: user.uid,
        friendName: user.displayName,
        friendPhoto: user.photoURL,
        createdAt: new Date().toISOString()
      });
      // Update request status in both places
      await setDoc(doc(db, `users/${user.uid}/friendRequests`, request.id), { status: 'accepted' }, { merge: true });
      await setDoc(doc(db, `users/${request.fromId}/friendRequests`, request.id), { status: 'accepted' }, { merge: true });
    } catch (err) {
      console.error('Accept friend error:', err);
    }
  };

  const rejectFriendRequest = async (request: FriendRequest) => {
    if (!user) return;
    try {
      await setDoc(doc(db, `users/${user.uid}/friendRequests`, request.id), { status: 'declined' }, { merge: true });
      await setDoc(doc(db, `users/${request.fromId}/friendRequests`, request.id), { status: 'declined' }, { merge: true });
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

  if (loading) return <div className="h-screen w-full flex items-center justify-center bg-discord-darkest text-white">Loading...</div>;

  if (!user) return <LoginScreen onLogin={loginWithGoogle} />;

  return (
    <div className="h-screen w-full flex overflow-hidden">
      {/* Server Sidebar */}
      <div className="w-[72px] bg-discord-darkest flex flex-col items-center py-3 gap-2 flex-shrink-0">
        <ServerIcon 
          name="Friends" 
          active={showFriendsView} 
          onClick={() => {
            setShowFriendsView(true);
            setActiveServer(null);
          }} 
          icon={<Users size={28} />}
          className={showFriendsView ? "bg-discord-blurple text-white" : ""}
          badge={friendRequests.filter(r => r.status === 'pending' && r.toId === user.uid).length}
        />
        <div className="w-8 h-[2px] bg-discord-dark rounded-full my-1" />
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
          className="text-discord-green hover:bg-discord-green hover:text-white"
        />
      </div>

      {/* Channel Sidebar */}
      <div className="w-60 bg-discord-sidebar flex flex-col flex-shrink-0">
        <div className="h-12 px-4 flex items-center justify-between border-b border-discord-darkest shadow-sm">
          <h1 className="font-bold truncate">{showFriendsView ? 'Friends' : (activeServer?.name || 'Direct Messages')}</h1>
        </div>
        
        <div className="flex-1 overflow-y-auto p-2 space-y-4">
          {showFriendsView ? (
            <div className="space-y-2">
              <button 
                onClick={() => {}} 
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded bg-discord-dark text-discord-text"
              >
                <Users size={20} />
                <span className="font-medium">Friends</span>
              </button>
              <button 
                onClick={() => setShowAddFriend(true)} 
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-discord-muted hover:bg-discord-dark hover:text-discord-text transition-all"
              >
                <UserPlus size={20} />
                <span className="font-medium">Add Friend</span>
              </button>
            </div>
          ) : activeServer && (
            <>
              <div>
                <div className="flex items-center justify-between px-2 mb-1 group">
                  <span className="text-xs font-semibold text-discord-muted uppercase tracking-wider">Channels</span>
                  <button onClick={() => setShowCreateChannel(true)} className="text-discord-muted hover:text-discord-text transition-colors">
                    <Plus size={14} />
                  </button>
                </div>
                <div className="space-y-0.5">
                  {channels.map(channel => (
                    <ChannelItem 
                      key={channel.id}
                      channel={channel}
                      active={activeChannel?.id === channel.id}
                      onClick={() => setActiveChannel(channel)}
                    />
                  ))}
                </div>
              </div>
              
              <div className="mt-6">
                <div className="flex items-center justify-between px-2 mb-1 group">
                  <span className="text-xs font-semibold text-discord-muted uppercase tracking-wider">Members — {serverMembers.length}</span>
                  <button onClick={() => setShowInviteFriends(true)} className="text-discord-muted hover:text-discord-text transition-colors" title="Invite Friends">
                    <UserPlus size={14} />
                  </button>
                </div>
                <div className="space-y-1">
                  {serverMembers.map(member => (
                    <div key={member.uid} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-discord-dark transition-colors cursor-default group">
                      <div className="relative">
                        <img src={member.photoURL} className="w-6 h-6 rounded-full" />
                        <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-discord-green border-2 border-discord-sidebar rounded-full" />
                      </div>
                      <span className="text-sm text-discord-muted group-hover:text-discord-text truncate">{member.displayName}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* User Info */}
        <div className="h-14 bg-discord-darker px-2 flex items-center gap-2">
          <img src={user.photoURL || ''} className="w-8 h-8 rounded-full" referrerPolicy="no-referrer" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold truncate leading-tight">{user.displayName}</p>
            <p className="text-xs text-discord-muted truncate">#{user.uid.slice(0, 4)}</p>
          </div>
          <button onClick={logout} className="p-2 text-discord-muted hover:text-discord-text hover:bg-discord-dark rounded transition-colors">
            <LogOut size={18} />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 bg-discord-dark flex flex-col min-w-0">
        <AnimatePresence mode="wait">
          {showFriendsView ? (
            <motion.div 
              key="friends-view"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 flex flex-col"
            >
              <div className="h-12 px-4 flex items-center justify-between border-b border-discord-darkest shadow-sm">
                <div className="flex items-center gap-2">
                  <Users size={24} className="text-discord-muted" />
                  <h2 className="font-bold">Friends</h2>
                </div>
                <div className="flex gap-4 text-sm font-medium">
                  <button 
                    onClick={() => setFriendsFilter('online')}
                    className={cn(friendsFilter === 'online' ? "text-discord-text" : "text-discord-muted hover:text-discord-text")}
                  >
                    Online
                  </button>
                  <button 
                    onClick={() => setFriendsFilter('all')}
                    className={cn(friendsFilter === 'all' ? "text-discord-text" : "text-discord-muted hover:text-discord-text")}
                  >
                    All
                  </button>
                  <button 
                    onClick={() => setFriendsFilter('pending')}
                    className={cn(friendsFilter === 'pending' ? "text-discord-text" : "text-discord-muted hover:text-discord-text")}
                  >
                    Pending
                    {friendRequests.filter(r => r.status === 'pending' && r.toId === user.uid).length > 0 && (
                      <span className="ml-1 bg-red-500 text-white text-[10px] px-1 rounded-full">
                        {friendRequests.filter(r => r.status === 'pending' && r.toId === user.uid).length}
                      </span>
                    )}
                  </button>
                  <button 
                    onClick={() => setShowAddFriend(true)}
                    className="bg-discord-green text-white px-2 py-0.5 rounded hover:bg-opacity-90 transition-all"
                  >
                    Add Friend
                  </button>
                </div>
              </div>
              
              <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
                {friendsFilter === 'pending' ? (
                  <section>
                    <h3 className="text-xs font-semibold text-discord-muted uppercase tracking-wider mb-4">Pending Requests</h3>
                    <div className="space-y-2">
                      {friendRequests.filter(r => r.status === 'pending').map(req => (
                        <div key={req.id} className="bg-discord-darker p-3 rounded flex items-center justify-between group hover:bg-discord-dark transition-all">
                          <div className="flex items-center gap-3">
                            <img 
                              src={req.fromId === user.uid ? 'https://api.dicebear.com/7.x/initials/svg?seed=' + req.toId : req.fromPhoto} 
                              className="w-10 h-10 rounded-full" 
                              referrerPolicy="no-referrer"
                            />
                            <div>
                              <p className="font-bold">
                                {req.fromId === user.uid ? `Request to ${req.toId.substring(0, 8)}` : req.fromName}
                              </p>
                              <p className="text-xs text-discord-muted">
                                {req.fromId === user.uid ? 'Outgoing Friend Request' : 'Incoming Friend Request'}
                              </p>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            {req.fromId !== user.uid ? (
                              <>
                                <button 
                                  onClick={() => acceptFriendRequest(req)}
                                  className="bg-discord-green p-2 rounded-full hover:bg-opacity-80 transition-all text-white shadow-lg"
                                  title="Accept"
                                >
                                  <Check size={20} />
                                </button>
                                <button 
                                  onClick={() => rejectFriendRequest(req)}
                                  className="bg-red-500 p-2 rounded-full hover:bg-opacity-80 transition-all text-white shadow-lg"
                                  title="Decline"
                                >
                                  <X size={20} />
                                </button>
                              </>
                            ) : (
                              <button 
                                onClick={() => rejectFriendRequest(req)}
                                className="p-2 text-discord-muted hover:text-red-500 transition-all"
                                title="Cancel Request"
                              >
                                <X size={20} />
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                      {friendRequests.filter(r => r.status === 'pending').length === 0 && (
                        <p className="text-center py-8 text-discord-muted italic">No pending requests.</p>
                      )}
                    </div>
                  </section>
                ) : (
                  <section>
                    <h3 className="text-xs font-semibold text-discord-muted uppercase tracking-wider mb-4">
                      {friendsFilter === 'online' ? 'Online Friends' : 'All Friends'} — {friends.length}
                    </h3>
                    <div className="space-y-2">
                      {friends.map(friend => (
                        <div key={friend.friendId} className="bg-discord-darker p-3 rounded flex items-center justify-between group hover:bg-discord-dark transition-all">
                          <div className="flex items-center gap-3">
                            <div className="relative">
                              <img src={friend.friendPhoto} className="w-10 h-10 rounded-full" referrerPolicy="no-referrer" />
                              <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-discord-green border-2 border-discord-darker rounded-full" />
                            </div>
                            <p className="font-bold">{friend.friendName}</p>
                          </div>
                          <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button className="p-2 bg-discord-darkest rounded-full text-discord-muted hover:text-discord-text hover:bg-discord-dark transition-all">
                              <MessageSquare size={20} />
                            </button>
                            <button className="p-2 bg-discord-darkest rounded-full text-discord-muted hover:text-discord-text hover:bg-discord-dark transition-all">
                              <Settings size={20} />
                            </button>
                          </div>
                        </div>
                      ))}
                      {friends.length === 0 && (
                        <div className="text-center py-8 text-discord-muted">
                          <p>No friends found. Start by searching for users!</p>
                        </div>
                      )}
                    </div>
                  </section>
                )}
              </div>
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
              <div className="h-12 px-4 flex items-center justify-between border-b border-discord-darkest shadow-sm">
                <div className="flex items-center gap-2">
                  {activeChannel.type === 'text' ? <Hash size={24} className="text-discord-muted" /> : <Volume2 size={24} className="text-discord-muted" />}
                  <h2 className="font-bold">{activeChannel.name}</h2>
                </div>
                <div className="flex items-center gap-4 text-discord-muted">
                  <InviteDropdown friends={friends} onInvite={inviteToChannel} />
                  {activeChannel.type === 'text' && (
                    <button onClick={handleSummarize} className="hover:text-discord-text flex items-center gap-1 text-sm font-medium">
                      <Sparkles size={18} />
                      Summarize
                    </button>
                  )}
                  <Settings size={20} className="hover:text-discord-text cursor-pointer" />
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
              className="flex-1 flex flex-col items-center justify-center text-discord-muted p-8 text-center"
            >
              <div className="w-24 h-24 bg-discord-darker rounded-full flex items-center justify-center mb-4">
                <MessageSquare size={48} />
              </div>
              <h2 className="text-2xl font-bold text-discord-text mb-2">Welcome to Cyberse Link</h2>
              <p className="max-w-md">Select a server and channel to start communicating. Use @ai to talk to the assistant!</p>
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
      <p className="text-discord-muted mb-6">Select friends to invite them to this server.</p>
      <div className="space-y-2 max-h-80 overflow-y-auto custom-scrollbar">
        {friends.map((friend: Friendship) => (
          <div key={friend.friendId} className="bg-discord-darkest p-3 rounded flex items-center justify-between group hover:bg-discord-darker transition-all">
            <div className="flex items-center gap-3">
              <img src={friend.friendPhoto} className="w-10 h-10 rounded-full border-2 border-transparent group-hover:border-discord-blurple transition-all" referrerPolicy="no-referrer" />
              <div>
                <p className="font-bold">{friend.friendName}</p>
                <p className="text-xs text-discord-muted">Friend</p>
              </div>
            </div>
            <button 
              onClick={() => {
                onInvite(friend);
                onClose();
              }}
              className="bg-discord-green text-white px-4 py-1.5 rounded text-sm font-bold hover:bg-opacity-90 transition-all"
            >
              Invite
            </button>
          </div>
        ))}
        {friends.length === 0 && (
          <div className="text-center py-8 text-discord-muted">
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
        className="bg-discord-green text-white text-xs font-bold px-3 py-1 rounded hover:bg-opacity-90 transition-all"
      >
        Invite
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-56 bg-discord-darkest rounded-lg shadow-xl border border-discord-dark p-2 z-50">
          <p className="text-xs font-bold text-discord-muted px-2 mb-2 uppercase">Invite Friends</p>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {friends.map(friend => (
              <button 
                key={friend.friendId}
                onClick={() => {
                  onInvite(friend);
                  setOpen(false);
                }}
                className="w-full flex items-center gap-2 p-2 hover:bg-discord-blurple rounded transition-colors text-left"
              >
                <img src={friend.friendPhoto} className="w-6 h-6 rounded-full" />
                <span className="text-sm truncate">{friend.friendName}</span>
              </button>
            ))}
            {friends.length === 0 && <p className="text-xs text-discord-muted p-2">No friends to invite.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="h-screen w-full flex items-center justify-center bg-discord-darkest p-4">
      <div className="bg-discord-dark p-8 rounded-lg shadow-2xl w-full max-w-md text-center">
        <div className="w-20 h-20 bg-discord-blurple rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg">
          <Sparkles size={40} className="text-white" />
        </div>
        <h1 className="text-3xl font-bold mb-2">Cyberse Link</h1>
        <p className="text-discord-muted mb-8">The next generation AI communication platform</p>
        <button 
          onClick={onLogin}
          className="w-full bg-discord-blurple hover:bg-opacity-90 text-white font-bold py-3 px-4 rounded transition-all flex items-center justify-center gap-3"
        >
          <img src="https://www.google.com/favicon.ico" className="w-5 h-5 bg-white rounded-full p-0.5" />
          Continue with Google
        </button>
      </div>
    </div>
  );
}

function ServerIcon({ name, active, onClick, icon, image, className, badge }: any) {
  return (
    <div className="relative group flex items-center justify-center w-full">
      <div className={cn(
        "absolute left-0 w-1 bg-white rounded-r-full transition-all duration-200",
        active ? "h-10" : "h-2 group-hover:h-5 opacity-0 group-hover:opacity-100"
      )} />
      <button 
        onClick={onClick}
        title={name}
        className={cn(
          "w-12 h-12 flex items-center justify-center transition-all duration-200 overflow-hidden relative",
          active ? "rounded-[16px] bg-discord-blurple text-white" : "rounded-[24px] bg-discord-dark hover:rounded-[16px] hover:bg-discord-blurple text-discord-text hover:text-white",
          className
        )}
      >
        {image ? <img src={image} className="w-full h-full object-cover" /> : icon || name[0]}
        {badge > 0 && (
          <div className="absolute -bottom-1 -right-1 bg-red-500 text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center border-2 border-discord-darkest shadow-lg">
            {badge}
          </div>
        )}
      </button>
    </div>
  );
}

function ChannelItem({ channel, active, onClick }: any) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1.5 rounded group transition-colors",
        active ? "bg-discord-dark text-discord-text" : "text-discord-muted hover:bg-discord-dark hover:text-discord-text"
      )}
    >
      {channel.type === 'text' ? <Hash size={20} /> : <Volume2 size={20} />}
      <span className="font-medium truncate">{channel.name}</span>
    </button>
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
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-6 scrollbar-hide">
        {messages.map((msg: Message) => (
          <div key={msg.id} className="flex gap-4 group">
            <img src={msg.authorPhoto} className="w-10 h-10 rounded-full flex-shrink-0 mt-0.5" referrerPolicy="no-referrer" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className={cn("font-bold hover:underline cursor-pointer", msg.isAI && "text-discord-blurple")}>
                  {msg.authorName}
                </span>
                {msg.isAI && <span className="bg-discord-blurple text-[10px] px-1 rounded text-white font-bold uppercase">AI</span>}
                <span className="text-xs text-discord-muted">
                  {msg.timestamp?.toDate ? format(msg.timestamp.toDate(), 'HH:mm') : 'Just now'}
                </span>
              </div>
              <div className="text-discord-text leading-relaxed break-words markdown-body">
                <Markdown>{msg.content}</Markdown>
              </div>
            </div>
          </div>
        ))}
        {isAIThinking && (
          <div className="flex gap-4 animate-pulse">
            <div className="w-10 h-10 rounded-full bg-discord-darker" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-24 bg-discord-darker rounded" />
              <div className="h-4 w-full bg-discord-darker rounded" />
            </div>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="p-4">
        <div className="bg-discord-darker rounded-lg px-4 py-2 flex items-center gap-3">
          <button type="button" className="text-discord-muted hover:text-discord-text">
            <Plus size={24} />
          </button>
          <input 
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type @ai to ask the assistant..."
            className="flex-1 bg-transparent border-none outline-none text-discord-text placeholder:text-discord-muted py-2"
          />
          <div className="flex items-center gap-3 text-discord-muted">
            <button type="button" className="hover:text-discord-text"><Sparkles size={20} /></button>
            <button type="submit" className="text-discord-blurple hover:text-opacity-80 disabled:opacity-50" disabled={!input.trim()}>
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
    <div className="flex-1 flex flex-col bg-discord-darkest p-4">
      {!inCall ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <div className="w-20 h-20 bg-discord-dark rounded-full flex items-center justify-center mb-6">
            <Volume2 size={40} className="text-discord-muted" />
          </div>
          <h2 className="text-2xl font-bold mb-2">Voice Channel: {channel.name}</h2>
          <p className="text-discord-muted mb-8 max-w-sm">Hop into the call to chat with others in real-time using voice and video.</p>
          <button 
            onClick={() => setInCall(true)}
            className="bg-discord-green hover:bg-opacity-90 text-white font-bold py-3 px-12 rounded-full transition-all"
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
              <div className="bg-discord-dark rounded-2xl flex flex-col items-center justify-center relative overflow-hidden aspect-video border border-dashed border-discord-muted opacity-50">
                <div className="w-20 h-20 bg-discord-darker rounded-full flex items-center justify-center mb-4">
                  <User size={40} className="text-discord-muted" />
                </div>
                <div className="absolute bottom-4 left-4 bg-black bg-opacity-50 px-3 py-1 rounded text-sm font-bold">
                  Waiting for others...
                </div>
              </div>
            )}
          </div>

          {/* Call Controls */}
          <div className="h-24 flex items-center justify-center gap-4">
            <button 
              onClick={() => setIsMuted(!isMuted)}
              className={cn(
                "w-12 h-12 rounded-full flex items-center justify-center transition-all",
                isMuted ? "bg-red-500 text-white" : "bg-discord-dark text-discord-text hover:bg-discord-darker"
              )}
            >
              {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
            </button>
            <button 
              onClick={() => setIsVideoOn(!isVideoOn)}
              className={cn(
                "w-12 h-12 rounded-full flex items-center justify-center transition-all",
                !isVideoOn ? "bg-red-500 text-white" : "bg-discord-dark text-discord-text hover:bg-discord-darker"
              )}
            >
              {!isVideoOn ? <VideoOff size={24} /> : <Video size={24} />}
            </button>
            <button 
              onClick={() => setInCall(false)}
              className="w-12 h-12 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-all"
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
        className="absolute inset-0 bg-black bg-opacity-70 backdrop-blur-sm" 
      />
      <motion.div 
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="relative bg-discord-dark w-full max-w-md rounded-lg shadow-2xl overflow-hidden"
      >
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold text-white">{title}</h2>
            <button onClick={onClose} className="text-discord-muted hover:text-white transition-colors">
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
    <Modal isOpen={isOpen} onClose={onClose} title="Customize your server">
      <p className="text-discord-muted mb-6">Give your new server a personality with a name and an icon. You can always change it later.</p>
      <div className="space-y-4">
        <div className="flex flex-col items-center mb-6">
          <div className="w-20 h-20 bg-discord-darker rounded-full border-2 border-dashed border-discord-muted flex flex-col items-center justify-center text-discord-muted cursor-pointer hover:border-discord-blurple transition-colors relative overflow-hidden">
            {image ? <img src={image} className="w-full h-full object-cover" /> : (
              <>
                <Plus size={24} />
                <span className="text-[10px] font-bold uppercase">Upload</span>
              </>
            )}
          </div>
        </div>
        <div>
          <label className="text-xs font-bold text-discord-muted uppercase mb-2 block">Server Name</label>
          <input 
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter server name"
            className="w-full bg-discord-darkest p-3 rounded text-discord-text outline-none focus:ring-2 focus:ring-discord-blurple transition-all"
          />
        </div>
        <div>
          <label className="text-xs font-bold text-discord-muted uppercase mb-2 block">Icon URL (Optional)</label>
          <input 
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="https://example.com/icon.png"
            className="w-full bg-discord-darkest p-3 rounded text-discord-text outline-none focus:ring-2 focus:ring-discord-blurple transition-all"
          />
        </div>
      </div>
      <div className="mt-8 flex justify-end gap-3">
        <button onClick={onClose} className="px-6 py-2 text-white hover:underline">Cancel</button>
        <button 
          onClick={handleCreate}
          disabled={!name.trim() || loading}
          className="bg-discord-blurple text-white font-bold px-6 py-2 rounded hover:bg-opacity-90 transition-all disabled:opacity-50"
        >
          {loading ? 'Creating...' : 'Create'}
        </button>
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
          <label className="text-xs font-bold text-discord-muted uppercase mb-3 block">Channel Type</label>
          <div className="space-y-2">
            <button 
              onClick={() => setType('text')}
              className={cn(
                "w-full flex items-center gap-3 p-3 rounded transition-all",
                type === 'text' ? "bg-discord-darker border border-discord-blurple" : "bg-discord-darkest hover:bg-discord-darker border border-transparent"
              )}
            >
              <Hash size={24} className="text-discord-muted" />
              <div className="text-left">
                <p className="font-bold">Text</p>
                <p className="text-xs text-discord-muted">Send messages, images, and GIFs.</p>
              </div>
              {type === 'text' && <div className="ml-auto w-4 h-4 bg-discord-blurple rounded-full flex items-center justify-center"><Check size={12} /></div>}
            </button>
            <button 
              onClick={() => setType('voice')}
              className={cn(
                "w-full flex items-center gap-3 p-3 rounded transition-all",
                type === 'voice' ? "bg-discord-darker border border-discord-blurple" : "bg-discord-darkest hover:bg-discord-darker border border-transparent"
              )}
            >
              <Volume2 size={24} className="text-discord-muted" />
              <div className="text-left">
                <p className="font-bold">Voice</p>
                <p className="text-xs text-discord-muted">Hang out with voice, video, and screen share.</p>
              </div>
              {type === 'voice' && <div className="ml-auto w-4 h-4 bg-discord-blurple rounded-full flex items-center justify-center"><Check size={12} /></div>}
            </button>
          </div>
        </div>
        <div>
          <label className="text-xs font-bold text-discord-muted uppercase mb-2 block">Channel Name</label>
          <div className="relative">
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-discord-muted">
              {type === 'text' ? <Hash size={18} /> : <Volume2 size={18} />}
            </div>
            <input 
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="new-channel"
              className="w-full bg-discord-darkest p-3 pl-10 rounded text-discord-text outline-none focus:ring-2 focus:ring-discord-blurple transition-all"
            />
          </div>
        </div>
      </div>
      <div className="mt-8 flex justify-end gap-3">
        <button onClick={onClose} className="px-6 py-2 text-white hover:underline">Cancel</button>
        <button 
          onClick={handleCreate}
          disabled={!name.trim() || loading}
          className="bg-discord-blurple text-white font-bold px-6 py-2 rounded hover:bg-opacity-90 transition-all disabled:opacity-50"
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
          <div className="w-16 h-16 bg-discord-green rounded-full flex items-center justify-center mb-4 text-white">
            <Check size={32} />
          </div>
          <h3 className="text-xl font-bold mb-2">Friend Request Sent!</h3>
          <p className="text-discord-muted">We've sent a request to that user.</p>
        </div>
      ) : (
        <>
          <p className="text-discord-muted mb-6">You can add friends with their email address.</p>
          <div className="relative mb-6">
            <input 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Enter an email address"
              className="w-full bg-discord-darkest p-3 rounded text-discord-text outline-none focus:ring-2 focus:ring-discord-blurple transition-all"
            />
            <button 
              onClick={handleSearch}
              disabled={loading || !email.trim()}
              className="absolute right-2 top-1/2 -translate-y-1/2 bg-discord-blurple text-white px-4 py-1.5 rounded text-sm font-bold hover:bg-opacity-90 transition-all disabled:opacity-50"
            >
              {loading ? 'Searching...' : 'Search'}
            </button>
          </div>
          
          <div className="space-y-2 max-h-60 overflow-y-auto custom-scrollbar">
            {searchResults.map((res: UserProfile) => (
              <div key={res.uid} className="bg-discord-darkest p-3 rounded flex items-center justify-between group hover:bg-discord-darker transition-all">
                <div className="flex items-center gap-3">
                  <img src={res.photoURL} className="w-10 h-10 rounded-full border-2 border-transparent group-hover:border-discord-blurple transition-all" referrerPolicy="no-referrer" />
                  <div>
                    <p className="font-bold">{res.displayName}</p>
                    <p className="text-xs text-discord-muted">{res.email}</p>
                  </div>
                </div>
                <button 
                  onClick={() => handleAdd(res)}
                  disabled={loading}
                  className="bg-discord-blurple p-2 rounded-full hover:bg-opacity-80 transition-all text-white shadow-lg disabled:opacity-50"
                >
                  <UserPlus size={20} />
                </button>
              </div>
            ))}
            {searchResults.length === 0 && email && !loading && (
              <p className="text-center py-4 text-discord-muted text-sm italic">No users found with that email.</p>
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
        "bg-discord-dark rounded-2xl flex flex-col items-center justify-center relative overflow-hidden aspect-video transition-all group",
        isLocal ? "border-2 border-discord-blurple shadow-lg" : "border border-discord-darker hover:border-discord-muted"
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
            <img src={participant.photoURL} className="w-24 h-24 rounded-full mb-4 shadow-2xl border-4 border-discord-darker" referrerPolicy="no-referrer" />
            {!stream && (
              <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-40 rounded-full">
                <Loader2 className="text-white animate-spin" size={32} />
              </div>
            )}
          </div>
          {!stream && <p className="text-xs text-discord-muted font-bold tracking-widest uppercase">Connecting...</p>}
          {stream && !hasVideo && <p className="text-xs text-discord-muted font-bold tracking-widest uppercase">Video Off</p>}
        </div>
      )}
      <div className="absolute bottom-4 left-4 bg-black bg-opacity-60 backdrop-blur-md px-3 py-1.5 rounded-lg text-sm font-bold flex items-center gap-2 border border-white border-opacity-10">
        <div className={cn("w-2 h-2 rounded-full", stream ? "bg-discord-green" : "bg-discord-muted animate-pulse")} />
        <span className="truncate max-w-[120px]">{participant.displayName} {isLocal && "(You)"}</span>
      </div>
    </div>
  );
}
