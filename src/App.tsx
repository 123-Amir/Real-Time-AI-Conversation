import { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Sparkles, Volume2, Heart, Star } from 'lucide-react';

const CONVERSATION_DURATION = 60;

type AIState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

function App() {
  const [aiState, setAIState] = useState<AIState>('idle');
  const [timeRemaining, setTimeRemaining] = useState(CONVERSATION_DURATION);
  const [isActive, setIsActive] = useState(false);
  const [transcript, setTranscript] = useState<string[]>([]);
  const [imageEffect, setImageEffect] = useState<'none' | 'sparkle' | 'heart' | 'star'>('none');

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (isActive && timeRemaining > 0) {
      timerRef.current = setInterval(() => {
        setTimeRemaining(prev => {
          if (prev <= 1) {
            stopConversation();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isActive, timeRemaining]);

  const startConversation = async () => {
    try {
      setAIState('connecting');
      setIsActive(true);
      setTimeRemaining(CONVERSATION_DURATION);
      setTranscript([]);

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/realtime-session`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create session');
      }

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioElementRef.current = audioEl;

      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
      };

      const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
      pc.addTrack(ms.getTracks()[0]);

      const dc = pc.createDataChannel('oai-events');
      dataChannelRef.current = dc;

      dc.onopen = () => {
        console.log('Data channel opened');

        const initialMessage = {
          type: 'session.update',
          session: {
            turn_detection: { type: 'server_vad' },
            input_audio_transcription: { model: 'whisper-1' },
            tools: [
              {
                type: 'function',
                name: 'add_effect_to_image',
                description: 'Add a visual effect to the image on screen (sparkle, heart, or star effect)',
                parameters: {
                  type: 'object',
                  properties: {
                    effect: {
                      type: 'string',
                      enum: ['sparkle', 'heart', 'star'],
                      description: 'The type of effect to add to the image'
                    }
                  },
                  required: ['effect']
                }
              }
            ],
            instructions: `You are a friendly, enthusiastic AI assistant talking to a child about the colorful hot air balloons in the image.

Your goal is to have a fun, engaging 1-minute conversation:
- Start by greeting the child warmly and asking what they see in the image
- Ask open-ended questions about the balloons, colors, and what the child imagines
- Be playful and encouraging
- Use simple, child-friendly language
- Show excitement about their answers
- Occasionally use the add_effect_to_image tool to add visual effects (sparkle, heart, or star) to the image when something exciting happens
- Keep the conversation flowing naturally

Remember: You're talking to a young child, so be patient, encouraging, and fun!`
          }
        };

        dc.send(JSON.stringify(initialMessage));

        const conversationItem = {
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Hi! Please start our conversation by telling me about this picture!'
              }
            ]
          }
        };
        dc.send(JSON.stringify(conversationItem));

        dc.send(JSON.stringify({ type: 'response.create' }));
      };

      dc.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          console.log('Message:', msg.type);

          if (msg.type === 'session.created') {
            setAIState('listening');
          } else if (msg.type === 'response.audio.delta') {
            setAIState('speaking');
          } else if (msg.type === 'response.audio.done') {
            setAIState('listening');
          } else if (msg.type === 'input_audio_buffer.speech_started') {
            setAIState('listening');
          } else if (msg.type === 'conversation.item.input_audio_transcription.completed') {
            setTranscript(prev => [...prev, `You: ${msg.transcript}`]);
          } else if (msg.type === 'response.function_call_arguments.done') {
            const args = JSON.parse(msg.arguments);
            if (msg.name === 'add_effect_to_image' && args.effect) {
              setImageEffect(args.effect);
              setTimeout(() => setImageEffect('none'), 2000);
            }

            const functionOutput = {
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: msg.call_id,
                output: JSON.stringify({ success: true, effect: args.effect })
              }
            };
            dc.send(JSON.stringify(functionOutput));
            dc.send(JSON.stringify({ type: 'response.create' }));
          } else if (msg.type === 'response.done') {
            const transcript = msg.response?.output?.[0]?.content?.[0]?.transcript;
            if (transcript) {
              setTranscript(prev => [...prev, `AI: ${transcript}`]);
            }
          }
        } catch (err) {
          console.error('Error processing message:', err);
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch(data.client_secret.value, {
        method: 'POST',
        body: offer.sdp,
        headers: {
          'Content-Type': 'application/sdp',
          'Authorization': `Bearer ${data.client_secret.value}`,
        },
      });

      const answer = {
        type: 'answer' as RTCSdpType,
        sdp: await sdpResponse.text(),
      };
      await pc.setRemoteDescription(answer);

    } catch (error) {
      console.error('Error starting conversation:', error);
      setAIState('idle');
      setIsActive(false);
    }
  };

  const stopConversation = () => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }
    if (audioElementRef.current) {
      audioElementRef.current.srcObject = null;
      audioElementRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setAIState('idle');
    setIsActive(false);
    setTimeRemaining(CONVERSATION_DURATION);
  };

  const getStateColor = () => {
    switch (aiState) {
      case 'listening': return 'bg-green-500';
      case 'thinking': return 'bg-yellow-500';
      case 'speaking': return 'bg-blue-500';
      case 'connecting': return 'bg-purple-500';
      default: return 'bg-gray-400';
    }
  };

  const getStateText = () => {
    switch (aiState) {
      case 'listening': return 'Listening to you...';
      case 'thinking': return 'Thinking...';
      case 'speaking': return 'Speaking...';
      case 'connecting': return 'Connecting...';
      default: return 'Press Start to begin!';
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-300 via-pink-200 to-yellow-200 p-4">
      <div className="max-w-6xl mx-auto">
        <header className="text-center py-6">
          <h1 className="text-5xl font-bold text-white drop-shadow-lg mb-2 flex items-center justify-center gap-3">
            <Sparkles className="w-12 h-12 text-yellow-400" />
            Let's Talk About This Picture!
            <Sparkles className="w-12 h-12 text-yellow-400" />
          </h1>
          <p className="text-xl text-white drop-shadow">Have a fun conversation with AI!</p>
        </header>

        <div className="grid lg:grid-cols-2 gap-6 mb-6">
          <div className="relative">
            <div className="bg-white rounded-3xl shadow-2xl overflow-hidden border-8 border-white">
              <div className="relative">
                <img
                  src="https://images.pexels.com/photos/163041/hot-air-balloons-valley-sky-163041.jpeg?auto=compress&cs=tinysrgb&w=1200"
                  alt="Colorful hot air balloons in the sky"
                  className="w-full h-auto"
                />

                {imageEffect === 'sparkle' && (
                  <div className="absolute inset-0 pointer-events-none">
                    {[...Array(20)].map((_, i) => (
                      <Sparkles
                        key={i}
                        className="absolute text-yellow-300 animate-ping"
                        style={{
                          left: `${Math.random() * 100}%`,
                          top: `${Math.random() * 100}%`,
                          animationDelay: `${Math.random() * 0.5}s`
                        }}
                      />
                    ))}
                  </div>
                )}

                {imageEffect === 'heart' && (
                  <div className="absolute inset-0 pointer-events-none">
                    {[...Array(15)].map((_, i) => (
                      <Heart
                        key={i}
                        className="absolute text-red-400 animate-ping fill-current"
                        style={{
                          left: `${Math.random() * 100}%`,
                          top: `${Math.random() * 100}%`,
                          animationDelay: `${Math.random() * 0.5}s`
                        }}
                      />
                    ))}
                  </div>
                )}

                {imageEffect === 'star' && (
                  <div className="absolute inset-0 pointer-events-none">
                    {[...Array(15)].map((_, i) => (
                      <Star
                        key={i}
                        className="absolute text-yellow-400 animate-ping fill-current"
                        style={{
                          left: `${Math.random() * 100}%`,
                          top: `${Math.random() * 100}%`,
                          animationDelay: `${Math.random() * 0.5}s`
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-6">
            <div className="bg-white rounded-3xl shadow-2xl p-8 border-8 border-white">
              <div className="text-center mb-6">
                <div className={`inline-flex items-center gap-3 px-6 py-4 rounded-full ${getStateColor()} text-white text-xl font-bold shadow-lg transition-all duration-300`}>
                  {aiState === 'listening' && <Mic className="w-8 h-8 animate-pulse" />}
                  {aiState === 'speaking' && <Volume2 className="w-8 h-8 animate-pulse" />}
                  {aiState === 'thinking' && <Sparkles className="w-8 h-8 animate-spin" />}
                  {getStateText()}
                </div>
              </div>

              <div className="text-center mb-6">
                <div className="text-7xl font-bold text-gray-800 mb-2">
                  {Math.floor(timeRemaining / 60)}:{(timeRemaining % 60).toString().padStart(2, '0')}
                </div>
                <div className="text-lg text-gray-600">Time Remaining</div>
                <div className="w-full bg-gray-200 rounded-full h-4 mt-4 overflow-hidden">
                  <div
                    className="bg-gradient-to-r from-green-400 to-blue-500 h-4 transition-all duration-1000 ease-linear"
                    style={{ width: `${(timeRemaining / CONVERSATION_DURATION) * 100}%` }}
                  />
                </div>
              </div>

              <div className="flex gap-4">
                {!isActive ? (
                  <button
                    onClick={startConversation}
                    className="flex-1 bg-gradient-to-r from-green-400 to-blue-500 text-white px-8 py-6 rounded-2xl font-bold text-2xl shadow-lg hover:shadow-xl transform hover:scale-105 transition-all duration-200 flex items-center justify-center gap-3"
                  >
                    <Mic className="w-8 h-8" />
                    Start Talking!
                  </button>
                ) : (
                  <button
                    onClick={stopConversation}
                    className="flex-1 bg-gradient-to-r from-red-400 to-pink-500 text-white px-8 py-6 rounded-2xl font-bold text-2xl shadow-lg hover:shadow-xl transform hover:scale-105 transition-all duration-200 flex items-center justify-center gap-3"
                  >
                    <MicOff className="w-8 h-8" />
                    Stop
                  </button>
                )}
              </div>
            </div>

            <div className="bg-white rounded-3xl shadow-2xl p-6 border-8 border-white max-h-64 overflow-y-auto">
              <h3 className="text-2xl font-bold text-gray-800 mb-4 flex items-center gap-2">
                <Sparkles className="w-6 h-6 text-yellow-500" />
                Conversation
              </h3>
              {transcript.length === 0 ? (
                <p className="text-gray-400 text-center py-4">Start the conversation to see what you talk about!</p>
              ) : (
                <div className="space-y-2">
                  {transcript.map((line, idx) => (
                    <div
                      key={idx}
                      className={`p-3 rounded-xl ${
                        line.startsWith('You:')
                          ? 'bg-blue-100 text-blue-900'
                          : 'bg-green-100 text-green-900'
                      }`}
                    >
                      <p className="text-sm font-medium">{line}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
