import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import axios from "axios";

// In production, prefer same-origin requests. Allow override via VITE_API_BASE / VITE_WS_BASE
const API_BASE = (import.meta.env?.VITE_API_BASE ?? "");
const WS_BASE = (import.meta.env?.VITE_WS_BASE ?? "");
const buildApiUrl = (path) => {
  if (API_BASE) return `${API_BASE}${path}`;
  return path;
};
const buildWsUrl = (path) => {
  if (WS_BASE) return `${WS_BASE}${path}`;
  if (typeof window !== 'undefined') return `${window.location.origin.replace(/^http/, 'ws')}${path}`;
  return `ws://localhost:5055${path}`;
};

function useAudioRecorder() {
  const mediaStream = useRef(null);
  const mediaRecorder = useRef(null);
  const chunks = useRef([]);
  const listeners = useRef([]);
  const levelListeners = useRef([]);
  const audioCtx = useRef(null);
  const analyser = useRef(null);
  const levelTimer = useRef(null);

  const start = async () => {
    mediaStream.current = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : undefined;
    mediaRecorder.current = new MediaRecorder(
      mediaStream.current,
      mime ? { mimeType: mime } : undefined
    );
    chunks.current = [];
    mediaRecorder.current.ondataavailable = (e) => {
      if (e.data.size) {
        chunks.current.push(e.data);
        listeners.current.forEach((fn) => fn(e.data));
      }
    };
    // analyser for mic level
    audioCtx.current = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.current.createMediaStreamSource(
      mediaStream.current
    );
    analyser.current = audioCtx.current.createAnalyser();
    analyser.current.fftSize = 1024;
    source.connect(analyser.current);
    const data = new Uint8Array(analyser.current.fftSize);
    const tick = () => {
      if (!analyser.current) return;
      analyser.current.getByteTimeDomainData(data);
      // RMS level 0..1
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      levelListeners.current.forEach((fn) => fn(rms));
    };
    levelTimer.current = setInterval(tick, 50);

    // pass a timeslice so ondataavailable fires periodically (larger chunk aids decoding)
    mediaRecorder.current.start(2000);
  };
  const stop = async () => {
    if (!mediaRecorder.current) return null;
    await new Promise((r) => {
      mediaRecorder.current.onstop = r;
      mediaRecorder.current.stop();
    });
    mediaStream.current?.getTracks().forEach((t) => t.stop());
    if (levelTimer.current) {
      clearInterval(levelTimer.current);
      levelTimer.current = null;
    }
    if (audioCtx.current) {
      try {
        audioCtx.current.close();
      } catch {}
      audioCtx.current = null;
      analyser.current = null;
    }
    const blob = new Blob(chunks.current, { type: "audio/webm" });
    const arrayBuffer = await blob.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  };
  const requestPermission = async () => {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
    return true;
  };
  const onChunk = (fn) => {
    listeners.current.push(fn);
    return () => {
      listeners.current = listeners.current.filter((f) => f !== fn);
    };
  };
  const onLevel = (fn) => {
    levelListeners.current.push(fn);
    return () => {
      levelListeners.current = levelListeners.current.filter((f) => f !== fn);
    };
  };
  return { start, stop, onChunk, onLevel, requestPermission };
}

function ConfigModal({ open, initial, onClose, onSave }) {
  const [greeting, setGreeting] = useState(initial.greeting);
  const [goal, setGoal] = useState(initial.goal);
  const [model, setModel] = useState(initial.model);
  if (!open) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3 style={{ marginTop: 0 }}>Set your robot</h3>
        <div style={{ display: "grid", gap: 10 }}>
          <div>
            <label>Greeting message (optional)</label>
            <input
              maxLength={100}
              value={greeting}
              onChange={(e) => setGreeting(e.target.value)}
              placeholder="Hello, world!"
            />
          </div>
          <div>
            <label>Give your robot a goal</label>
            <textarea
              rows={4}
              maxLength={400}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Speak spanish and try to make fun of another robot..."
            />
          </div>
          <div>
            <label>Model</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option>Llama 4 Maverick</option>
              <option>Local Small</option>
              <option>Cloud Powerful</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={() => onSave({ greeting, goal, model })}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [health, setHealth] = useState(null);
  const [listening, setListening] = useState(false);
  const [inSession, setInSession] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [config, setConfig] = useState({
    greeting: "Hello, world!",
    goal: "",
    model: "Llama 4 Maverick",
  });
  const [leftMsgs, setLeftMsgs] = useState([]);
  const [rightMsgs, setRightMsgs] = useState([]);
  const [script, setScript] = useState("hiiiiiii\nhellooooo");
  const recorder = useAudioRecorder();
  const [status, setStatus] = useState("Idle");
  const wsRef = useRef(null);
  const [showDebug, setShowDebug] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [debug, setDebug] = useState([]);

  useEffect(() => {
    axios
      .get(buildApiUrl(`/health`))
      .then((r) => setHealth(r.data))
      .catch(() => setHealth({ ok: false }));
  }, []);

  const log = (entry) =>
    setDebug((d) => [...d.slice(-199), { t: Date.now(), ...entry }]);

  const startSession = async () => {
    setInSession(true);
    openWs();
  };
  const endSession = async () => {
    if (listening) {
      await recorder.stop();
      setListening(false);
    }
    setInSession(false);
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  };

  // WS control using ggwave-cli (sender side real-time)
  const openWs = () => {
    if (wsRef.current) return;
    const ws = new WebSocket(buildWsUrl(`/ws/cli`));
    ws.onopen = () => {
      setStatus("WS connected (CLI mode)");
      log({ type: "ws", msg: "connected" });
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        log({ type: "ws_msg", msg });
        if (msg.type === "decoded" && msg.message) {
          setLeftMsgs((m) => [...m, { role: "user", text: msg.message }]);
        } else if (msg.type === "stderr" && typeof msg.data === "string") {
          const m = msg.data.match(
            /Received sound data successfully:\s*'([^']+)'/
          );
          if (m && m[1]) {
            setLeftMsgs((v) => [...v, { role: "user", text: m[1] }]);
          }
        }
      } catch {
        log({ type: "ws_raw", data: ev.data });
      }
    };
    ws.onerror = () => {
      setStatus("WS error");
      log({ type: "ws", msg: "error" });
    };
    ws.onclose = () => {
      setStatus("WS closed");
      log({ type: "ws", msg: "closed" });
    };
    wsRef.current = ws;
  };

  const sendRight = async (text) => {
    setRightMsgs((m) => [...m, { role: "bot", text }]);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "send", text }));
      log({ type: "ws_send", text });
      // Do not return; still do local encode so audio plays client-side
    }
    const started = performance.now();
    const resp = await fetch(buildApiUrl(`/encode-long`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    const wav = await resp.arrayBuffer();
    log({
      type: "http_encode_ms",
      ms: Math.round(performance.now() - started),
    });

    // Play the audio
    const audio = new Audio(
      URL.createObjectURL(new Blob([wav], { type: "audio/wav" }))
    );
    await new Promise((resolve) => {
      audio.onended = resolve;
      audio.play();
    });

    // Download the audio file
    downloadAudioFile(wav, text);
  };

  const downloadAudioFile = (audioBuffer, text) => {
    try {
      const blob = new Blob([audioBuffer], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `voice_${Date.now()}_${text
        .substring(0, 20)
        .replace(/[^a-zA-Z0-9]/g, "_")}.wav`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      console.log("Audio file downloaded successfully");
    } catch (error) {
      console.error("Error downloading audio file:", error);
    }
  };

  const playScriptSequentially = async () => {
    const lines = script
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const line of lines) {
      await sendRight(line);
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  const uploadForDecode = async (file) => {
    const form = new FormData();
    form.append("file", file);
    const started = performance.now();
    const r = await fetch(buildApiUrl(`/decode`), { method: "POST", body: form });
    const j = await r.json();
    log({
      type: "http_decode_ms",
      ms: Math.round(performance.now() - started),
      message: j.message,
    });
    setLeftMsgs((m) => [
      ...m,
      { role: "user", text: j.message || "(no message detected)" },
    ]);
  };

  return (
    <div
      style={{
        height: "100vh",
        background:
          "linear-gradient(135deg, #0a0a0a 0%, #1a0a1a 50%, #0a0a1a 100%)",
        fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      {!inSession ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            padding: "20px",
          }}
        >
          <div
            style={{
              textAlign: "center",
              position: "relative",
              background: "rgba(20, 20, 30, 0.8)",
              backdropFilter: "blur(10px)",
              borderRadius: "20px",
              padding: "40px",
              border: "1px solid rgba(139, 92, 246, 0.2)",
              boxShadow:
                "0 20px 40px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(139, 92, 246, 0.1)",
              maxWidth: "500px",
              width: "100%",
            }}
          >
            <div
              style={{
                width: "80px",
                height: "80px",
                background: "linear-gradient(135deg, #8b5cf6, #a855f7)",
                borderRadius: "50%",
                margin: "0 auto 30px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "32px",
                cursor: "pointer",
                transition: "all 0.3s ease",
                boxShadow: "0 10px 30px rgba(139, 92, 246, 0.3)",
                position: "relative",
                overflow: "hidden",
              }}
              onClick={() => setModalOpen(true)}
              title="Tap to change"
              onMouseEnter={(e) => {
                e.target.style.transform = "scale(1.1)";
                e.target.style.boxShadow =
                  "0 15px 40px rgba(139, 92, 246, 0.4)";
              }}
              onMouseLeave={(e) => {
                e.target.style.transform = "scale(1)";
                e.target.style.boxShadow =
                  "0 10px 30px rgba(139, 92, 246, 0.3)";
              }}
            >
              <div
                style={{
                  fontSize: "28px",
                  filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.3))",
                  animation: "pulse 2s infinite",
                }}
              >
                <img
                  src="/image1.png"
                  alt="Logo"
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    display: "block",
                    margin: "0 10px auto 0",
                  }}
                />
              </div>
            </div>

            <h1
              style={{
                color: "#ffffff",
                fontSize: "28px",
                fontWeight: "600",
                marginBottom: "8px",
                background: "linear-gradient(135deg, #ffffff, #a855f7)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}
            >
              VoCrypt
            </h1>

            <p
              style={{
                color: "#a1a1aa",
                fontSize: "16px",
                marginBottom: "30px",
                lineHeight: "1.5",
              }}
            >
              Advanced voice encryption with AI-powered communication
            </p>

            <div
              style={{
                display: "flex",
                gap: "12px",
                justifyContent: "center",
                marginBottom: "20px",
              }}
            >
              <button
                className="btn"
                onClick={() => setModalOpen(true)}
                style={{
                  background: "rgba(139, 92, 246, 0.1)",
                  border: "1px solid rgba(139, 92, 246, 0.3)",
                  color: "#a855f7",
                  padding: "12px 24px",
                  borderRadius: "12px",
                  fontSize: "14px",
                  fontWeight: "500",
                  transition: "all 0.3s ease",
                  outline: "none",
                }}
                onMouseEnter={(e) => {
                  e.target.style.background = "rgba(139, 92, 246, 0.2)";
                  e.target.style.transform = "translateY(-2px)";
                }}
                onMouseLeave={(e) => {
                  e.target.style.background = "rgba(139, 92, 246, 0.1)";
                  e.target.style.transform = "translateY(0)";
                }}
              >
                Configure
              </button>
              <button
                className="btn primary"
                onClick={startSession}
                // onClick={}
                style={{
                  background: "linear-gradient(135deg, #8b5cf6, #a855f7)",
                  border: "none",
                  color: "#ffffff",
                  padding: "12px 32px",
                  borderRadius: "12px",
                  fontSize: "14px",
                  fontWeight: "600",
                  transition: "all 0.3s ease",
                  outline: "none",
                  boxShadow: "0 4px 15px rgba(139, 92, 246, 0.3)",
                }}
                onMouseEnter={(e) => {
                  e.target.style.transform = "translateY(-2px)";
                  e.target.style.boxShadow =
                    "0 8px 25px rgba(139, 92, 246, 0.4)";
                }}
                onMouseLeave={(e) => {
                  e.target.style.transform = "translateY(0)";
                  e.target.style.boxShadow =
                    "0 4px 15px rgba(139, 92, 246, 0.3)";
                }}
              >
                Start Session
              </button>
            </div>

            <div
              style={{
                marginTop: "20px",
                padding: "12px 20px",
                background: "rgba(20, 20, 30, 0.6)",
                borderRadius: "10px",
                border: "1px solid rgba(139, 92, 246, 0.1)",
              }}
            >
              <div
                style={{
                  color: health?.ok ? "#10b981" : "#ef4444",
                  fontSize: "14px",
                  fontWeight: "500",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                }}
              >
                <div
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: health?.ok ? "#10b981" : "#ef4444",
                    animation: health?.ok ? "pulse 2s infinite" : "none",
                  }}
                ></div>
                {health
                  ? health.ok
                    ? "Server Ready"
                    : "Server Not Ready"
                  : "Checking..."}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            height: "100vh",
            gap: "20px",
            padding: "20px",
            background: "transparent",
          }}
        >
          <div
            style={{
              flex: 1,
              background: "rgba(20, 20, 30, 0.8)",
              backdropFilter: "blur(10px)",
              borderRadius: "16px",
              border: "1px solid rgba(139, 92, 246, 0.2)",
              boxShadow: "0 10px 30px rgba(0, 0, 0, 0.3)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "20px",
                borderBottom: "1px solid rgba(139, 92, 246, 0.1)",
                background:
                  "linear-gradient(135deg, rgba(139, 92, 246, 0.1), rgba(168, 85, 247, 0.05))",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                  }}
                >
                  <div
                    style={{
                      width: "12px",
                      height: "12px",
                      borderRadius: "50%",
                      background: "linear-gradient(135deg, #8b5cf6, #a855f7)",
                      boxShadow: "0 0 10px rgba(139, 92, 246, 0.5)",
                    }}
                  ></div>
                  <h3
                    style={{
                      color: "#ffffff",
                      fontSize: "18px",
                      fontWeight: "600",
                      margin: 0,
                    }}
                  >
                    Listener Bot
                  </h3>
                </div>
                <div>
                  <input
                    type="file"
                    accept="audio/wav"
                    onChange={(e) =>
                      e.target.files?.[0] && uploadForDecode(e.target.files[0])
                    }
                    style={{
                      background: "rgba(20, 20, 30, 0.8)",
                      border: "1px solid rgba(139, 92, 246, 0.3)",
                      borderRadius: "12px",
                      color: "#ffffff",
                      padding: "10px 16px",
                      outline: "none",
                      fontSize: "14px",
                      transition: "all 0.3s ease",
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => {
                      e.target.style.borderColor = "rgba(139, 92, 246, 0.5)";
                      e.target.style.background = "rgba(20, 20, 30, 0.9)";
                    }}
                    onMouseLeave={(e) => {
                      e.target.style.borderColor = "rgba(139, 92, 246, 0.3)";
                      e.target.style.background = "rgba(20, 20, 30, 0.8)";
                    }}
                  />
                  <button
                    className="btn"
                    style={{
                      marginLeft: "12px",
                      marginTop: "5px",
                      outline: "none",
                      border: "1px solid rgba(139, 92, 246, 0.3)",
                      borderRadius: "12px",
                      background: "rgba(139, 92, 246, 0.1)",
                      color: "#a855f7",
                      padding: "10px 20px",
                      fontSize: "14px",
                      fontWeight: "500",
                      transition: "all 0.3s ease",
                    }}
                    onMouseEnter={(e) => {
                      e.target.style.background = "rgba(139, 92, 246, 0.2)";
                      e.target.style.borderColor = "rgba(139, 92, 246, 0.5)";
                      e.target.style.transform = "translateY(-1px)";
                    }}
                    onMouseLeave={(e) => {
                      e.target.style.background = "rgba(139, 92, 246, 0.1)";
                      e.target.style.borderColor = "rgba(139, 92, 246, 0.3)";
                      e.target.style.transform = "translateY(0)";
                    }}
                    onClick={async () => {
                      if (!listening) {
                        try {
                          setStatus("Requesting microphone permission...");
                          await recorder.requestPermission();
                          setStatus("Listening...");
                          await recorder.start();
                          recorder.onLevel((lvl) => setMicLevel(lvl));
                        } catch (e) {
                          setStatus(
                            "Microphone permission denied or unavailable"
                          );
                          alert(
                            "Microphone permission is required. If blocked, allow mic for this site (localhost) or use HTTPS."
                          );
                          return;
                        }
                        recorder.onChunk(async (blob) => {
                          const form = new FormData();
                          form.append("file", blob, "chunk.webm");
                          try {
                            const t0 = performance.now();
                            const r = await fetch(`${API_BASE}/decode-webm`, {
                              method: "POST",
                              body: form,
                            });
                            const j = await r.json();
                            log({
                              type: "decode_webm_ms",
                              ms: Math.round(performance.now() - t0),
                              message: j.message,
                            });
                            if (j.message)
                              setLeftMsgs((m) => [
                                ...m,
                                { role: "user", text: j.message },
                              ]);
                          } catch (err) {
                            log({ type: "decode_webm_err", err: String(err) });
                          }
                        });
                        setListening(true);
                      } else {
                        await recorder.stop();
                        setStatus("Stopped");
                        setListening(false);
                      }
                    }}
                  >
                    {listening ? "Stop Listening" : "Start Listening"}
                  </button>
                </div>
              </div>
            </div>
            <div
              style={{
                flex: 1,
                padding: "20px",
                overflowY: "auto",
                background: "rgba(10, 10, 15, 0.3)",
              }}
            >
              {leftMsgs.length === 0 ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "100%",
                    color: "#6b7280",
                    fontSize: "16px",
                    textAlign: "center",
                  }}
                >
                  <div>
                    <div style={{ fontSize: "48px", marginBottom: "10px" }}>
                      🔊
                    </div>
                    <div>
                      No messages yet. Start listening to decode voice messages.
                    </div>
                  </div>
                </div>
              ) : (
                leftMsgs.map((m, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      background: "rgba(139, 92, 246, 0.1)",
                      border: "1px solid rgba(139, 92, 246, 0.2)",
                      borderRadius: "12px",
                      padding: "16px",
                      marginBottom: "12px",
                      transition: "all 0.3s ease",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background =
                        "rgba(139, 92, 246, 0.15)";
                      e.currentTarget.style.borderColor =
                        "rgba(139, 92, 246, 0.3)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background =
                        "rgba(139, 92, 246, 0.1)";
                      e.currentTarget.style.borderColor =
                        "rgba(139, 92, 246, 0.2)";
                    }}
                  >
                    <span
                      style={{
                        color: "#ffffff",
                        fontSize: "14px",
                        lineHeight: "1.5",
                        flex: 1,
                      }}
                    >
                      {m.text}
                    </span>
                    <button
                      className="btn"
                      style={{
                        fontSize: "14px",
                        padding: "8px 12px",
                        marginLeft: "12px",
                        background: "rgba(139, 92, 246, 0.2)",
                        border: "1px solid rgba(139, 92, 246, 0.3)",
                        borderRadius: "8px",
                        color: "#a855f7",
                        transition: "all 0.3s ease",
                      }}
                      onClick={async () => {
                        try {
                          const resp = await fetch(`${API_BASE}/encode-long`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ message: m.text }),
                          });
                          const wav = await resp.arrayBuffer();
                          downloadAudioFile(wav, m.text);
                        } catch (error) {
                          console.error("Error downloading audio:", error);
                        }
                      }}
                      onMouseEnter={(e) => {
                        e.target.style.background = "rgba(139, 92, 246, 0.3)";
                        e.target.style.transform = "scale(1.05)";
                      }}
                      onMouseLeave={(e) => {
                        e.target.style.background = "rgba(139, 92, 246, 0.2)";
                        e.target.style.transform = "scale(1)";
                      }}
                      title="Download audio"
                    >
                      📥 Download
                    </button>
                  </div>
                ))
              )}
            </div>
            <div
              style={{
                padding: "20px",
                borderTop: "1px solid rgba(139, 92, 246, 0.1)",
                background: "rgba(10, 10, 15, 0.5)",
                display: "flex",
                gap: "12px",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div style={{ display: "flex", gap: "12px" }}>
                <button
                  className="btn"
                  style={{
                    outline: "none",
                    border: "1px solid rgba(239, 68, 68, 0.3)",
                    background: "rgba(239, 68, 68, 0.1)",
                    color: "#f87171",
                    padding: "10px 20px",
                    borderRadius: "10px",
                    fontSize: "14px",
                    fontWeight: "500",
                    transition: "all 0.3s ease",
                  }}
                  onClick={endSession}
                  onMouseEnter={(e) => {
                    e.target.style.background = "rgba(239, 68, 68, 0.2)";
                    e.target.style.borderColor = "rgba(239, 68, 68, 0.5)";
                    e.target.style.transform = "translateY(-1px)";
                  }}
                  onMouseLeave={(e) => {
                    e.target.style.background = "rgba(239, 68, 68, 0.1)";
                    e.target.style.borderColor = "rgba(239, 68, 68, 0.3)";
                    e.target.style.transform = "translateY(0)";
                  }}
                >
                  End Session
                </button>
                <button
                  className="btn"
                  style={{
                    outline: "none",
                    border: "1px solid rgba(139, 92, 246, 0.3)",
                    background: "rgba(139, 92, 246, 0.1)",
                    color: "#a855f7",
                    padding: "10px 20px",
                    borderRadius: "10px",
                    fontSize: "14px",
                    fontWeight: "500",
                    transition: "all 0.3s ease",
                  }}
                  onClick={() => setShowDebug((s) => !s)}
                  onMouseEnter={(e) => {
                    e.target.style.background = "rgba(139, 92, 246, 0.2)";
                    e.target.style.borderColor = "rgba(139, 92, 246, 0.5)";
                    e.target.style.transform = "translateY(-1px)";
                  }}
                  onMouseLeave={(e) => {
                    e.target.style.background = "rgba(139, 92, 246, 0.1)";
                    e.target.style.borderColor = "rgba(139, 92, 246, 0.3)";
                    e.target.style.transform = "translateY(0)";
                  }}
                >
                  {showDebug ? "Hide" : "Show"} Debug
                </button>
              </div>
              <div
                style={{
                  color: "#6b7280",
                  fontSize: "12px",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <div
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: listening ? "#10b981" : "#6b7280",
                    animation: listening ? "pulse 2s infinite" : "none",
                  }}
                ></div>
                Status: {status}
              </div>
            </div>
            {showDebug && (
              <div
                style={{
                  padding: "20px",
                  borderTop: "1px solid rgba(139, 92, 246, 0.1)",
                  background: "rgba(10, 10, 15, 0.8)",
                }}
              >
                <div
                  style={{
                    fontSize: "14px",
                    color: "#a855f7",
                    marginBottom: "12px",
                    fontWeight: "500",
                  }}
                >
                  Microphone Level
                </div>
                <div
                  style={{
                    height: "8px",
                    background: "rgba(20, 20, 30, 0.8)",
                    borderRadius: "4px",
                    border: "1px solid rgba(139, 92, 246, 0.2)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${Math.min(100, Math.round(micLevel * 200))}%`,
                      background: "linear-gradient(90deg, #8b5cf6, #a855f7)",
                      borderRadius: "4px",
                      transition: "width 0.1s ease",
                    }}
                  />
                </div>
                <div
                  style={{
                    marginTop: "16px",
                    maxHeight: "200px",
                    overflow: "auto",
                    fontSize: "12px",
                    background: "rgba(20, 20, 30, 0.6)",
                    border: "1px solid rgba(139, 92, 246, 0.2)",
                    borderRadius: "8px",
                    padding: "12px",
                  }}
                >
                  {debug
                    .slice()
                    .reverse()
                    .map((e, i) => (
                      <div
                        key={i}
                        style={{
                          marginBottom: "6px",
                          padding: "4px 8px",
                          background: "rgba(139, 92, 246, 0.05)",
                          borderRadius: "4px",
                          border: "1px solid rgba(139, 92, 246, 0.1)",
                        }}
                      >
                        <code style={{ color: "#e5e7eb" }}>
                          {JSON.stringify(e)}
                        </code>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
          <div
            style={{
              flex: 1,
              background: "rgba(20, 20, 30, 0.8)",
              backdropFilter: "blur(10px)",
              borderRadius: "16px",
              border: "1px solid rgba(139, 92, 246, 0.2)",
              boxShadow: "0 10px 30px rgba(0, 0, 0, 0.3)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "20px",
                borderBottom: "1px solid rgba(139, 92, 246, 0.1)",
                background:
                  "linear-gradient(135deg, rgba(139, 92, 246, 0.1), rgba(168, 85, 247, 0.05))",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                  }}
                >
                  <div
                    style={{
                      width: "12px",
                      height: "12px",
                      borderRadius: "50%",
                      background: "linear-gradient(135deg, #10b981, #34d399)",
                      boxShadow: "0 0 10px rgba(16, 185, 129, 0.5)",
                    }}
                  ></div>
                  <h3
                    style={{
                      color: "#ffffff",
                      fontSize: "18px",
                      fontWeight: "600",
                      margin: 0,
                    }}
                  >
                    Speaker Bot
                  </h3>
                </div>
                <button
                  className="btn"
                  style={{
                    outline: "none",
                    border: "1px solid rgba(139, 92, 246, 0.3)",
                    background: "rgba(139, 92, 246, 0.1)",
                    color: "#a855f7",
                    padding: "10px 20px",
                    borderRadius: "12px",
                    fontSize: "14px",
                    fontWeight: "500",
                    transition: "all 0.3s ease",
                  }}
                  onClick={() => setModalOpen(true)}
                  onMouseEnter={(e) => {
                    e.target.style.background = "rgba(139, 92, 246, 0.2)";
                    e.target.style.borderColor = "rgba(139, 92, 246, 0.5)";
                    e.target.style.transform = "translateY(-1px)";
                  }}
                  onMouseLeave={(e) => {
                    e.target.style.background = "rgba(139, 92, 246, 0.1)";
                    e.target.style.borderColor = "rgba(139, 92, 246, 0.3)";
                    e.target.style.transform = "translateY(0)";
                  }}
                >
                  Config
                </button>
              </div>
            </div>
            <div
              style={{
                flex: 1,
                padding: "20px",
                overflowY: "auto",
                background: "rgba(10, 10, 15, 0.3)",
              }}
            >
              {rightMsgs.length === 0 ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "100%",
                    color: "#6b7280",
                    fontSize: "16px",
                    textAlign: "center",
                  }}
                >
                  <div>
                    <div style={{ fontSize: "48px", marginBottom: "16px" }}>
                      🎤
                    </div>
                    <div>
                      No messages yet. Send a message to encode and play audio.
                    </div>
                  </div>
                </div>
              ) : (
                rightMsgs.map((m, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      background: "rgba(16, 185, 129, 0.1)",
                      border: "1px solid rgba(16, 185, 129, 0.2)",
                      borderRadius: "12px",
                      padding: "16px",
                      marginBottom: "12px",
                      transition: "all 0.3s ease",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background =
                        "rgba(16, 185, 129, 0.15)";
                      e.currentTarget.style.borderColor =
                        "rgba(16, 185, 129, 0.3)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background =
                        "rgba(16, 185, 129, 0.1)";
                      e.currentTarget.style.borderColor =
                        "rgba(16, 185, 129, 0.2)";
                    }}
                  >
                    <span
                      style={{
                        color: "#ffffff",
                        fontSize: "14px",
                        lineHeight: "1.5",
                        flex: 1,
                      }}
                    >
                      {m.text}
                    </span>
                    <button
                      className="btn"
                      style={{
                        fontSize: "14px",
                        padding: "8px 12px",
                        marginLeft: "12px",
                        background: "rgba(16, 185, 129, 0.2)",
                        border: "1px solid rgba(16, 185, 129, 0.3)",
                        borderRadius: "8px",
                        color: "#34d399",
                        transition: "all 0.3s ease",
                      }}
                      onClick={async () => {
                        try {
                          const resp = await fetch(`${API_BASE}/encode-long`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ message: m.text }),
                          });
                          const wav = await resp.arrayBuffer();
                          downloadAudioFile(wav, m.text);
                        } catch (error) {
                          console.error("Error downloading audio:", error);
                        }
                      }}
                      onMouseEnter={(e) => {
                        e.target.style.background = "rgba(16, 185, 129, 0.3)";
                        e.target.style.transform = "scale(1.05)";
                      }}
                      onMouseLeave={(e) => {
                        e.target.style.background = "rgba(16, 185, 129, 0.2)";
                        e.target.style.transform = "scale(1)";
                      }}
                      title="Download audio"
                    >
                      📥 Download
                    </button>
                  </div>
                ))
              )}
            </div>
            <div
              style={{
                padding: "20px",
                borderTop: "1px solid rgba(139, 92, 246, 0.1)",
                background: "rgba(10, 10, 15, 0.5)",
                display: "flex",
                flexDirection: "column",
                gap: "16px",
              }}
            >
              <Composer onSend={sendRight} />
              <div>
                <label
                  style={{
                    fontSize: "14px",
                    color: "#a855f7",
                    marginBottom: "8px",
                    display: "block",
                    fontWeight: "500",
                  }}
                >
                  Conversation Script (one line per message)
                </label>
                <textarea
                  rows={4}
                  value={script}
                  onChange={(e) => setScript(e.target.value)}
                  placeholder={"hello\nworld"}
                  style={{
                    background: "rgba(20, 20, 30, 0.8)",
                    border: "1px solid rgba(139, 92, 246, 0.3)",
                    borderRadius: "12px",
                    color: "#ffffff",
                    padding: "12px",
                    outline: "none",
                    fontSize: "14px",
                    width: "100%",
                    resize: "vertical",
                    transition: "all 0.3s ease",
                    fontFamily: "inherit",
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = "rgba(139, 92, 246, 0.5)";
                    e.target.style.background = "rgba(20, 20, 30, 0.9)";
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = "rgba(139, 92, 246, 0.3)";
                    e.target.style.background = "rgba(20, 20, 30, 0.8)";
                  }}
                />
              </div>
              <div style={{ display: "flex", gap: "12px" }}>
                <button
                  className="btn primary"
                  style={{
                    outline: "none",
                    border: "none",
                    background: "linear-gradient(135deg, #8b5cf6, #a855f7)",
                    color: "#ffffff",
                    padding: "12px 24px",
                    borderRadius: "12px",
                    fontSize: "14px",
                    fontWeight: "600",
                    transition: "all 0.3s ease",
                    boxShadow: "0 4px 15px rgba(139, 92, 246, 0.3)",
                  }}
                  onClick={playScriptSequentially}
                  onMouseEnter={(e) => {
                    e.target.style.transform = "translateY(-2px)";
                    e.target.style.boxShadow =
                      "0 8px 25px rgba(139, 92, 246, 0.4)";
                  }}
                  onMouseLeave={(e) => {
                    e.target.style.transform = "translateY(0)";
                    e.target.style.boxShadow =
                      "0 4px 15px rgba(139, 92, 246, 0.3)";
                  }}
                >
                  Play Script
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <ConfigModal
        open={modalOpen}
        initial={config}
        onClose={() => setModalOpen(false)}
        onSave={(c) => {
          setConfig(c);
          setModalOpen(false);
        }}
      />
    </div>
  );
}

function Composer({ onSend }) {
  const [text, setText] = useState("hiiiiiii");
  return (
    <div style={{ display: "flex", gap: "12px" }}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type a message to encode and play..."
        style={{
          background: "rgba(20, 20, 30, 0.8)",
          border: "1px solid rgba(139, 92, 246, 0.3)",
          borderRadius: "12px",
          color: "#ffffff",
          padding: "12px 16px",
          outline: "none",
          fontSize: "14px",
          flex: 1,
          transition: "all 0.3s ease",
          fontFamily: "inherit",
        }}
        onFocus={(e) => {
          e.target.style.borderColor = "rgba(139, 92, 246, 0.5)";
          e.target.style.background = "rgba(20, 20, 30, 0.9)";
          e.target.style.boxShadow = "0 0 0 3px rgba(139, 92, 246, 0.1)";
        }}
        onBlur={(e) => {
          e.target.style.borderColor = "rgba(139, 92, 246, 0.3)";
          e.target.style.background = "rgba(20, 20, 30, 0.8)";
          e.target.style.boxShadow = "none";
        }}
        onKeyPress={(e) => {
          if (e.key === "Enter") {
            onSend(text);
            setText("");
          }
        }}
      />
      <button
        className="btn primary"
        style={{
          outline: "none",
          border: "none",
          background: "linear-gradient(135deg, #8b5cf6, #a855f7)",
          color: "#ffffff",
          padding: "12px 24px",
          borderRadius: "12px",
          fontSize: "14px",
          fontWeight: "600",
          transition: "all 0.3s ease",
          boxShadow: "0 4px 15px rgba(139, 92, 246, 0.3)",
          cursor: "pointer",
        }}
        onClick={() => {
          onSend(text);
          setText("");
        }}
        onMouseEnter={(e) => {
          e.target.style.transform = "translateY(-2px)";
          e.target.style.boxShadow = "0 8px 25px rgba(139, 92, 246, 0.4)";
        }}
        onMouseLeave={(e) => {
          e.target.style.transform = "translateY(0)";
          e.target.style.boxShadow = "0 4px 15px rgba(139, 92, 246, 0.3)";
        }}
      >
        🚀 Send
      </button>
    </div>
  );
}

// Add CSS animations
const style = document.createElement("style");
style.textContent = `
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(20px); }
    to { opacity: 1; transform: translateY(0); }
  }
  
  @keyframes slideIn {
    from { transform: translateX(-100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  
  * {
    box-sizing: border-box;
  }
  
  body {
    margin: 0;
    padding: 0;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: #0a0a0a;
    color: #ffffff;
    overflow-x: hidden;
  }
  
  #root {
    height: 100vh;
    width: 100vw;
  }
  
  .btn {
    cursor: pointer;
    border: none;
    outline: none;
    font-family: inherit;
    transition: all 0.3s ease;
  }
  
  .btn:hover {
    transform: translateY(-1px);
  }
  
  .btn:active {
    transform: translateY(0);
  }
  
  .msg {
    animation: fadeIn 0.3s ease;
  }
  
  .pane {
    animation: slideIn 0.5s ease;
  }
`;
document.head.appendChild(style);

createRoot(document.getElementById("root")).render(<App />);
