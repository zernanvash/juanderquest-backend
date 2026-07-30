import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';
import '../../quests/models/quest_model.dart';
import '../../submissions/providers/submission_provider.dart';
import '../../auth/providers/auth_provider.dart';

class ARExperienceScreen extends ConsumerStatefulWidget {
  final QuestModel quest;

  const ARExperienceScreen({super.key, required this.quest});

  @override
  ConsumerState<ARExperienceScreen> createState() => _ARExperienceScreenState();
}

class _ARExperienceScreenState extends ConsumerState<ARExperienceScreen> with SingleTickerProviderStateMixin {
  Position? _currentPosition;
  bool _markerDetected = false;
  bool _isCapturingGPS = true;
  String? _gpsError;
  late AnimationController _rotationController;

  @override
  void initState() {
    super.initState();
    _rotationController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 4),
    )..repeat();

    _captureRealGPS();
  }

  Future<void> _captureRealGPS() async {
    setState(() {
      _isCapturingGPS = true;
      _gpsError = null;
    });

    try {
      final serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        if (mounted) {
          setState(() {
            _gpsError = 'Location services are disabled on device.';
            _isCapturingGPS = false;
          });
        }
        return;
      }

      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
        if (permission == LocationPermission.denied) {
          if (mounted) {
            setState(() {
              _gpsError = 'Location permission denied.';
              _isCapturingGPS = false;
            });
          }
          return;
        }
      }

      if (permission == LocationPermission.deniedForever) {
        if (mounted) {
          setState(() {
            _gpsError = 'Location permission permanently denied. Enable in Settings.';
            _isCapturingGPS = false;
          });
        }
        return;
      }

      // Try acquiring position with fallback to last known location
      Position? pos;
      try {
        pos = await Geolocator.getCurrentPosition(
          desiredAccuracy: LocationAccuracy.medium,
          timeLimit: const Duration(seconds: 8),
        );
      } catch (_) {
        pos = await Geolocator.getLastKnownPosition();
      }

      if (pos != null) {
        if (mounted) {
          setState(() {
            _currentPosition = pos;
            _isCapturingGPS = false;
          });
        }
      } else {
        if (mounted) {
          setState(() {
            _gpsError = 'Unable to acquire GPS fix. Please ensure location services are ON.';
            _isCapturingGPS = false;
          });
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _gpsError = 'GPS error: ${e.toString()}';
          _isCapturingGPS = false;
        });
      }
    }
  }

  @override
  void dispose() {
    _rotationController.dispose();
    super.dispose();
  }

  Future<void> _submitProof() async {
    if (_currentPosition == null) return;

    final messenger = ScaffoldMessenger.of(context);
    final router = GoRouter.of(context);

    final success = await ref.read(submissionProvider.notifier).submitProof(
          questId: widget.quest.id,
          markerCode: widget.quest.markerCode,
          capturedLat: _currentPosition!.latitude,
          capturedLng: _currentPosition!.longitude,
          accuracy: _currentPosition!.accuracy,
        );

    if (success) {
      await ref.read(authProvider.notifier).refreshProfile();
      messenger.showSnackBar(
        const SnackBar(
          content: Text('Proof submitted successfully! Awaiting admin verification.'),
          backgroundColor: Color(0xFF10B981),
        ),
      );
      router.go('/history');
    } else {
      final err = ref.read(submissionProvider).error;
      messenger.showSnackBar(
        SnackBar(
          content: Text(err ?? 'Submission failed due to network error.'),
          backgroundColor: const Color(0xFFF43F5E),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final subState = ref.watch(submissionProvider);

    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          // Camera Viewfinder Canvas
          Container(
            width: double.infinity,
            height: double.infinity,
            decoration: const BoxDecoration(
              gradient: LinearGradient(
                colors: [Color(0xFF0F172A), Color(0xFF1E293B)],
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
              ),
            ),
            child: Center(
              child: Opacity(
                opacity: 0.2,
                child: Image.network(
                  widget.quest.markerImageUrl,
                  errorBuilder: (_, __, ___) => const Icon(Icons.qr_code_scanner, size: 200, color: Colors.white24),
                ),
              ),
            ),
          ),

          // Target Reticle
          Center(
            child: Container(
              width: 260,
              height: 260,
              decoration: BoxDecoration(
                border: Border.all(
                  color: _markerDetected ? const Color(0xFF10B981) : const Color(0xFF00F2FE),
                  width: 2,
                ),
                borderRadius: BorderRadius.circular(20),
              ),
            ),
          ),

          // 3D Animated Coin AR Overlay
          if (_markerDetected)
            Center(
              child: RotationTransition(
                turns: _rotationController,
                child: Container(
                  width: 140,
                  height: 140,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: const RadialGradient(
                      colors: [Color(0xFFFFD700), Color(0xFFFF8C00)],
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: const Color(0xFFFFD700).withOpacity(0.6),
                        blurRadius: 30,
                        spreadRadius: 5,
                      ),
                    ],
                  ),
                  child: const Center(
                    child: Icon(Icons.stars_rounded, size: 72, color: Color(0xFF0A0F1D)),
                  ),
                ),
              ),
            ),

          // Top Header & Real-time GPS HUD
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(16.0),
              child: Column(
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      IconButton(
                        icon: const Icon(Icons.close, color: Colors.white, size: 28),
                        onPressed: () => context.pop(),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                        decoration: BoxDecoration(
                          color: _markerDetected ? const Color(0xFF10B981) : const Color(0xFF00F2FE),
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Text(
                          _markerDetected ? 'MARKER TRACKED (AR ACTIVE)' : 'READY TO SCAN MARKER',
                          style: const TextStyle(color: Color(0xFF0A0F1D), fontWeight: FontWeight.bold, fontSize: 11),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  // Real GPS HUD Card
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: Colors.black.withOpacity(0.6),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: Colors.white24),
                    ),
                    child: Row(
                      children: [
                        Icon(
                          _gpsError != null ? Icons.error_outline : Icons.gps_fixed,
                          color: _gpsError != null ? const Color(0xFFF43F5E) : const Color(0xFF00F2FE),
                          size: 20,
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              if (_isCapturingGPS)
                                const Text('Acquiring real GPS coordinates...', style: TextStyle(color: Colors.white, fontSize: 12))
                              else if (_gpsError != null)
                                Text(_gpsError!, style: const TextStyle(color: Color(0xFFF43F5E), fontSize: 12, fontWeight: FontWeight.bold))
                              else
                                Text(
                                  'Lat: ${_currentPosition?.latitude.toStringAsFixed(4)}, Lng: ${_currentPosition?.longitude.toStringAsFixed(4)} (±${_currentPosition?.accuracy.toStringAsFixed(1)}m)',
                                  style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.bold),
                                ),
                            ],
                          ),
                        ),
                        if (_gpsError != null)
                          IconButton(
                            icon: const Icon(Icons.refresh, color: Colors.white, size: 18),
                            onPressed: _captureRealGPS,
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),

          // Bottom Action Controls
          Positioned(
            bottom: 30,
            left: 20,
            right: 20,
            child: Column(
              children: [
                if (!_markerDetected) ...[
                  ElevatedButton.icon(
                    onPressed: () => setState(() => _markerDetected = true),
                    icon: const Icon(Icons.qr_code_scanner),
                    label: const Text('Simulate AR Marker Recognition'),
                    style: ElevatedButton.styleFrom(
                      minimumSize: const Size.fromHeight(50),
                      backgroundColor: const Color(0xFF00F2FE),
                      foregroundColor: const Color(0xFF0A0F1D),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                    ),
                  ),
                  const SizedBox(height: 12),
                ],
                ElevatedButton.icon(
                  onPressed: (_markerDetected && _currentPosition != null && !subState.isSubmitting)
                      ? _submitProof
                      : null,
                  icon: subState.isSubmitting
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Icon(Icons.send_rounded),
                  label: Text(
                    subState.isSubmitting
                        ? 'Submitting Proof...'
                        : _markerDetected
                            ? 'Collect Proof & Submit to Admin'
                            : 'Scan Marker First',
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                  ),
                  style: ElevatedButton.styleFrom(
                    minimumSize: const Size.fromHeight(56),
                    backgroundColor: const Color(0xFF10B981),
                    foregroundColor: Colors.white,
                    disabledBackgroundColor: Colors.white12,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
