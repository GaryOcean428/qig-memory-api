'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Thin wrapper around the Web Speech API (SpeechRecognition). It is browser-only
// and unsupported in some browsers (notably Firefox), so callers must branch on
// `isSupported`. Final transcript chunks are pushed via onResult; interim
// (in-progress) text is exposed as `interim` for a live preview.
export function useSpeechRecognition({ onResult, lang = 'en-US' } = {}) {
  const [isSupported, setIsSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState(null);
  const recognitionRef = useRef(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    setIsSupported(true);
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;

    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      if (finalText && onResultRef.current) onResultRef.current(finalText);
      setInterim(interimText);
    };

    recognition.onerror = (event) => {
      // `no-speech` / `aborted` are benign; surface everything else.
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        setError(event.error || 'speech_error');
      }
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
      setInterim('');
    };

    recognitionRef.current = recognition;
    return () => {
      try {
        recognition.abort();
      } catch {
        /* already stopped */
      }
    };
  }, [lang]);

  const start = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition || isListening) return;
    setError(null);
    try {
      recognition.start();
      setIsListening(true);
    } catch {
      /* start() throws if already started; ignore */
    }
  }, [isListening]);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      /* already stopped */
    }
    setIsListening(false);
    setInterim('');
  }, []);

  const toggle = useCallback(() => {
    if (isListening) stop();
    else start();
  }, [isListening, start, stop]);

  return { isSupported, isListening, interim, error, start, stop, toggle };
}
