import AVFoundation
import Foundation
import Speech

struct JSONLine {
    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return encoder
    }()

    static func emit(_ payload: [String: String]) {
        var object = payload
        if object["type"] == nil { object["type"] = "event" }
        if let data = try? encoder.encode(object), let line = String(data: data, encoding: .utf8) {
            emitLine(line)
        }
    }

    private static func emitLine(_ line: String) {
        if let data = (line + "\n").data(using: .utf8) {
            FileHandle.standardOutput.write(data)
            fflush(stdout)
        }
    }
}

func speechAuthString(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .authorized: return "authorized"
    @unknown default: return "unknown"
    }
}

func micAuthString(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "authorized"
    @unknown default: return "unknown"
    }
}

func waitForSpeechAuthorization() -> SFSpeechRecognizerAuthorizationStatus {
    let current = SFSpeechRecognizer.authorizationStatus()
    if current != .notDetermined { return current }
    let semaphore = DispatchSemaphore(value: 0)
    var resolved = current
    SFSpeechRecognizer.requestAuthorization { status in
        resolved = status
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 60)
    return resolved
}

final class AuthorizationBox: @unchecked Sendable {
    var status: AVAuthorizationStatus
    init(_ status: AVAuthorizationStatus) { self.status = status }
}

func waitForMicAuthorization() -> AVAuthorizationStatus {
    let current = AVCaptureDevice.authorizationStatus(for: .audio)
    if current != .notDetermined { return current }
    let semaphore = DispatchSemaphore(value: 0)
    let resolved = AuthorizationBox(current)
    AVCaptureDevice.requestAccess(for: .audio) { granted in
        resolved.status = granted ? .authorized : .denied
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 60)
    return resolved.status
}

final class CaptureSession: @unchecked Sendable {
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var finalTranscript = ""
    private var didFinish = false
    private let lock = NSLock()
    private let recognizer: SFSpeechRecognizer

    init?(localeIdentifier: String) {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else { return nil }
        self.recognizer = recognizer
    }

    func start() throws {
        guard recognizer.isAvailable else {
            throw NSError(domain: "COTWSpeechHelper", code: 10, userInfo: [NSLocalizedDescriptionKey: "Speech recognizer is not available"])
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if #available(macOS 13.0, *) {
            request.addsPunctuation = true
        }
        self.request = request

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak request] buffer, _ in
            request?.append(buffer)
        }

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    self.lock.lock()
                    self.finalTranscript = text
                    self.lock.unlock()
                    JSONLine.emit(["type": result.isFinal ? "final" : "partial", "text": text])
                }
                if result.isFinal { self.markFinished() }
            }
            if let error {
                JSONLine.emit(["type": "error", "message": error.localizedDescription])
                self.markFinished()
            }
        }

        audioEngine.prepare()
        try audioEngine.start()
        JSONLine.emit(["type": "ready"])
    }

    func stop() {
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
    }

    func cancel() {
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
        task?.cancel()
        markFinished()
    }

    func waitForFinal(timeoutSeconds: TimeInterval) -> String {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            lock.lock()
            let done = didFinish
            let text = finalTranscript
            lock.unlock()
            if done { return text }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        lock.lock()
        let text = finalTranscript
        lock.unlock()
        return text
    }

    private func markFinished() {
        lock.lock()
        didFinish = true
        lock.unlock()
    }
}

func emitStatus() {
    let speech = SFSpeechRecognizer.authorizationStatus()
    let mic = AVCaptureDevice.authorizationStatus(for: .audio)
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: Locale.current.identifier))
    JSONLine.emit([
        "type": "status",
        "speechAuthorization": speechAuthString(speech),
        "microphoneAuthorization": micAuthString(mic),
        "recognizerAvailable": (recognizer?.isAvailable == true) ? "true" : "false",
        "locale": Locale.current.identifier,
    ])
}

func runCapture(locale: String) {
    let speechStatus = waitForSpeechAuthorization()
    guard speechStatus == .authorized else {
        JSONLine.emit(["type": "error", "code": "speech-permission", "message": "Speech Recognition permission is \(speechAuthString(speechStatus))"])
        exit(2)
    }

    let micStatus = waitForMicAuthorization()
    guard micStatus == .authorized else {
        JSONLine.emit(["type": "error", "code": "microphone-permission", "message": "Microphone permission is \(micAuthString(micStatus))"])
        exit(3)
    }

    guard let capture = CaptureSession(localeIdentifier: locale) else {
        JSONLine.emit(["type": "error", "code": "recognizer-unavailable", "message": "Could not create speech recognizer"])
        exit(4)
    }

    do {
        try capture.start()
    } catch {
        JSONLine.emit(["type": "error", "message": error.localizedDescription])
        exit(5)
    }

    let releaseSignal = DispatchSemaphore(value: 0)

    DispatchQueue.global(qos: .userInitiated).async {
        while let line = readLine() {
            let command = line.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if command == "stop" {
                capture.stop()
                releaseSignal.signal()
                return
            }
            if command == "cancel" {
                capture.cancel()
                releaseSignal.signal()
                return
            }
        }
        capture.stop()
        releaseSignal.signal()
    }

    // Push-to-talk should stay alive until the user releases the mic.
    // Apple's recognizer may produce a final result early because it detects
    // a pause, but that is not the same thing as the user ending the hold.
    _ = releaseSignal.wait(timeout: .now() + 300)
    let transcript = capture.waitForFinal(timeoutSeconds: 2).trimmingCharacters(in: .whitespacesAndNewlines)
    JSONLine.emit(["type": "done", "text": transcript])
}

let args = CommandLine.arguments.dropFirst()
let command = args.first ?? "status"
let locale = args.dropFirst().first ?? Locale.current.identifier

switch command {
case "status":
    emitStatus()
case "capture":
    runCapture(locale: locale)
default:
    JSONLine.emit(["type": "error", "message": "Unknown command: \(command)"])
    exit(64)
}
