import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Mic, MicOff, PhoneOff, Activity, ShieldCheck, HeartPulse, FileText, User } from 'lucide-react';
import { Agent, ConnectionState } from './types';
import { AGENTS, BASE_SYSTEM_INSTRUCTION } from './constants';
import { createBlob, decode, decodeAudioData } from './utils/audioUtils';
import AudioVisualizer from './components/AudioVisualizer';

const App: React.FC = () => {
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [isMicOn, setIsMicOn] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // Refs for audio handling to avoid re-render loops
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionPromiseRef = useRef<Promise<any> | null>(null);

  // Initialize contexts on mount
  useEffect(() => {
    inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

    return () => {
      disconnect();
      inputAudioContextRef.current?.close();
      outputAudioContextRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopAudioInput = () => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };

  const stopAudioOutput = () => {
    // Stop all currently playing sources
    audioSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) { /* ignore */ }
    });
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  };

  const disconnect = useCallback(async () => {
    setConnectionState('disconnected');
    stopAudioInput();
    stopAudioOutput();
    
    // Close session if exists
    if (sessionPromiseRef.current) {
      const session = await sessionPromiseRef.current;
      // There isn't a direct close method documented in the provided snippets, 
      // but stopping the streams effectively kills the interaction locally.
      // Ideally we would call session.close() if available in the SDK.
      // Based on provided code:
      // "When the conversation is finished, use session.close() to close the connection"
      try {
        session.close();
      } catch (e) {
        console.warn("Error closing session", e);
      }
      sessionPromiseRef.current = null;
    }
  }, []);

  const connectToGemini = async (agent: Agent) => {
    try {
      setErrorMsg(null);
      setConnectionState('connecting');

      const apiKey = process.env.API_KEY;
      if (!apiKey) {
        throw new Error("API Key not found in environment variables");
      }

      const ai = new GoogleGenAI({ apiKey });

      // Request Mic Access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const inputCtx = inputAudioContextRef.current;
      const outputCtx = outputAudioContextRef.current;

      if (!inputCtx || !outputCtx) throw new Error("Audio Context not initialized");
      
      // Resume contexts if suspended (browser policy)
      if (inputCtx.state === 'suspended') await inputCtx.resume();
      if (outputCtx.state === 'suspended') await outputCtx.resume();

      // Connect to Gemini Live
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: agent.voiceName } },
          },
          systemInstruction: `${BASE_SYSTEM_INSTRUCTION}\n\n${agent.systemInstructionAddon}`,
        },
        callbacks: {
          onopen: () => {
            setConnectionState('connected');
            console.log("Gemini Live Connected");

            // Setup Input Streaming
            const source = inputCtx.createMediaStreamSource(stream);
            sourceRef.current = source;
            
            // 4096 buffer size for balance between latency and performance
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            processorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (e) => {
              if (!isMicOn) return; // Mute logic

              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
               try {
                // Sync audio playback
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
                
                const audioBuffer = await decodeAudioData(
                  decode(base64Audio),
                  outputCtx,
                  24000,
                  1
                );

                const source = outputCtx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(outputCtx.destination);
                
                source.addEventListener('ended', () => {
                  audioSourcesRef.current.delete(source);
                });

                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                audioSourcesRef.current.add(source);
               } catch (err) {
                 console.error("Error decoding audio chunk", err);
               }
            }

            // Handle Interruption
            if (message.serverContent?.interrupted) {
              console.log("Interrupted by user");
              stopAudioOutput();
            }
          },
          onclose: () => {
            console.log("Session Closed");
            setConnectionState('disconnected');
          },
          onerror: (e) => {
            console.error("Session Error", e);
            setErrorMsg("Connection error. Please try again.");
            disconnect();
          }
        }
      });

      sessionPromiseRef.current = sessionPromise;

    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || "Failed to connect");
      setConnectionState('error');
    }
  };

  const handleAgentSelect = (agent: Agent) => {
    setSelectedAgent(agent);
    connectToGemini(agent);
  };

  const toggleMic = () => {
    setIsMicOn(prev => !prev);
  };

  // --- UI RENDER ---

  if (connectionState === 'connected' && selectedAgent) {
    return (
      <div className="min-h-screen bg-slate-900 text-white flex flex-col items-center justify-between p-6">
        {/* Active Call Header */}
        <div className="w-full max-w-md flex items-center justify-between">
          <div className="flex items-center space-x-3">
             <div className="w-10 h-10 rounded-full overflow-hidden border-2 border-white/20">
               <img src={selectedAgent.avatarUrl} alt={selectedAgent.name} className="w-full h-full object-cover" />
             </div>
             <div>
               <h3 className="font-semibold text-lg">{selectedAgent.name}</h3>
               <p className="text-xs text-slate-400">AtosCare Active Agent</p>
             </div>
          </div>
          <div className="flex items-center space-x-2 text-green-400 text-xs font-mono">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
            </span>
            <span>LIVE</span>
          </div>
        </div>

        {/* Visualizer Area */}
        <div className="w-full max-w-md flex-1 flex flex-col justify-center space-y-8">
            <div className="text-center space-y-2">
               <p className="text-slate-400 text-sm tracking-widest uppercase">Listening...</p>
            </div>
            
            <AudioVisualizer isActive={true} barColor={selectedAgent.style === 'serious' ? '#3b82f6' : '#ec4899'} />
            
            <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700/50 backdrop-blur-sm">
                <h4 className="text-sm font-semibold text-slate-300 mb-2">Capabilities</h4>
                <ul className="text-sm text-slate-400 space-y-2">
                    <li className="flex items-center gap-2"><Activity className="w-4 h-4" /> Procedural Explanations</li>
                    <li className="flex items-center gap-2"><FileText className="w-4 h-4" /> Pre-op Preparations</li>
                    <li className="flex items-center gap-2"><HeartPulse className="w-4 h-4" /> Post-op Recovery Care</li>
                </ul>
            </div>
        </div>

        {/* Controls */}
        <div className="w-full max-w-md flex justify-center space-x-6 pb-8">
            <button 
              onClick={toggleMic}
              className={`p-4 rounded-full transition-all duration-300 ${isMicOn ? 'bg-slate-700 hover:bg-slate-600 text-white' : 'bg-red-500/20 text-red-500 border border-red-500'}`}
            >
              {isMicOn ? <Mic size={28} /> : <MicOff size={28} />}
            </button>
            
            <button 
              onClick={disconnect}
              className="p-4 rounded-full bg-red-600 hover:bg-red-700 text-white shadow-lg hover:shadow-red-600/30 transition-all duration-300"
            >
              <PhoneOff size={28} />
            </button>
        </div>
      </div>
    );
  }

  // Selection Screen
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Brand Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2">
           <div className="bg-blue-600 text-white p-2 rounded-lg">
             <ShieldCheck size={24} />
           </div>
           <div>
             <h1 className="text-xl font-bold tracking-tight text-slate-900">AtosCare</h1>
             <p className="text-xs text-slate-500">Surgical Patient Education</p>
           </div>
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full p-6 flex flex-col items-center justify-center">
        <div className="text-center mb-12 max-w-2xl">
          <h2 className="text-3xl font-bold text-slate-900 mb-4">How can we help you today?</h2>
          <p className="text-lg text-slate-600">
            Select an AI assistant to guide you through your upcoming procedure, pre-operative instructions, or recovery guidelines.
          </p>
        </div>

        {errorMsg && (
          <div className="w-full max-w-md bg-red-50 text-red-600 p-4 rounded-lg mb-8 border border-red-100 flex items-center justify-center">
            {errorMsg}
          </div>
        )}

        {connectionState === 'connecting' ? (
           <div className="flex flex-col items-center justify-center space-y-4 animate-pulse">
             <div className="w-16 h-16 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
             <p className="text-slate-500 font-medium">Connecting to secure medical line...</p>
           </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 w-full max-w-4xl">
            {AGENTS.map((agent) => (
              <div 
                key={agent.id}
                onClick={() => handleAgentSelect(agent)}
                className="group relative bg-white rounded-2xl shadow-sm border border-slate-200 p-6 cursor-pointer hover:shadow-xl hover:border-blue-300 hover:-translate-y-1 transition-all duration-300"
              >
                 <div className="absolute top-6 right-6 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="bg-blue-100 text-blue-700 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider">Select</span>
                 </div>

                 <div className="flex items-start space-x-4">
                    <div className="w-20 h-20 rounded-full overflow-hidden bg-slate-100 shadow-inner">
                      <img src={agent.avatarUrl} alt={agent.name} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" />
                    </div>
                    <div>
                      <h3 className="text-xl font-bold text-slate-900">{agent.name}</h3>
                      <p className={`text-sm font-medium ${agent.style === 'serious' ? 'text-blue-600' : 'text-pink-600'}`}>{agent.role}</p>
                    </div>
                 </div>

                 <div className="mt-6 space-y-3">
                   <p className="text-slate-600 leading-relaxed text-sm h-16">
                     {agent.description}
                   </p>
                   
                   <div className="flex items-center gap-2 text-xs text-slate-400 bg-slate-50 p-3 rounded-lg">
                      <User size={14} />
                      <span>Best for: {agent.style === 'serious' ? 'Detailed medical facts & risks' : 'Anxiety relief & care tips'}</span>
                   </div>
                 </div>
                 
                 <div className="mt-6 w-full py-3 bg-slate-900 text-white text-center rounded-lg opacity-0 group-hover:opacity-100 transform translate-y-2 group-hover:translate-y-0 transition-all duration-300 font-medium">
                    Start Consultation
                 </div>
              </div>
            ))}
          </div>
        )}
      </main>
      
      <footer className="bg-slate-50 border-t border-slate-200 py-6 text-center text-slate-400 text-sm">
        <p>&copy; {new Date().getFullYear()} AtosCare AI. HIPAA Compliant Interface.</p>
        <p className="text-xs mt-1">Disclaimer: This is an AI education tool, not a doctor. In emergencies, call 911.</p>
      </footer>
    </div>
  );
};

export default App;
