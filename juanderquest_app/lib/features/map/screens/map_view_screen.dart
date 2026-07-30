import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:maplibre_gl/maplibre_gl.dart';
import '../../../core/config/map_config.dart';
import '../../quests/providers/quest_provider.dart';
import '../../quests/models/quest_model.dart';

class MapViewScreen extends ConsumerStatefulWidget {
  const MapViewScreen({super.key});

  @override
  ConsumerState<MapViewScreen> createState() => _MapViewScreenState();
}

class _MapViewScreenState extends ConsumerState<MapViewScreen> {
  MapLibreMapController? _mapController;
  QuestModel? _selectedQuest;
  bool _mapError = false;

  void _onMapCreated(MapLibreMapController controller) {
    _mapController = controller;
    _syncQuestMarkers();
  }

  void _syncQuestMarkers() {
    if (_mapController == null) return;

    try {
      final quests = ref.read(questProvider).quests;
      _mapController!.clearCircles();

      for (int i = 0; i < quests.length; i++) {
        final quest = quests[i];
        _mapController!.addCircle(
          CircleOptions(
            geometry: LatLng(quest.gpsLat, quest.gpsLng),
            circleColor: MapConfig.markerGoldHex,
            circleRadius: 12.0,
            circleStrokeWidth: 3.0,
            circleStrokeColor: MapConfig.markerBorderHex,
          ),
        );
      }

      _mapController!.onCircleTapped.add((circle) {
        final quests = ref.read(questProvider).quests;
        final match = quests.firstWhere(
          (q) => (q.gpsLat - circle.options.geometry!.latitude).abs() < 0.01 &&
              (q.gpsLng - circle.options.geometry!.longitude).abs() < 0.01,
          orElse: () => quests.first,
        );
        setState(() => _selectedQuest = match);
      });
    } catch (_) {
      // Graceful fallback to interactive map layout if GL fails
      setState(() => _mapError = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final questState = ref.watch(questProvider);

    ref.listen(questProvider, (previous, next) {
      if (next.quests != previous?.quests) {
        _syncQuestMarkers();
      }
    });

    return Scaffold(
      backgroundColor: const Color(0xFFFAF9F5),
      appBar: AppBar(
        backgroundColor: const Color(0xFFFAF9F5),
        elevation: 0,
        scrolledUnderElevation: 0,
        title: Text(
          'Quest Map',
          style: GoogleFonts.epilogue(
            color: const Color(0xFF582F0E),
            fontSize: 20,
            fontWeight: FontWeight.bold,
          ),
        ),
      ),
      body: Stack(
        children: [
          // Fallback Pangasinan Region Interactive Map Layout
          Container(
            width: double.infinity,
            height: double.infinity,
            decoration: const BoxDecoration(
              color: Color(0xFFE9E8E4),
              image: DecorationImage(
                image: AssetImage('assets/images/pangasinan_banner.png'),
                fit: BoxFit.cover,
                colorFilter: ColorFilter.mode(Colors.black38, BlendMode.darken),
              ),
            ),
            child: Stack(
              children: [
                Positioned(
                  top: 180,
                  left: 120,
                  child: _buildMapPin(
                    questTitle: 'Hundred Islands Eco Trek',
                    onTap: () {
                      if (questState.quests.isNotEmpty) {
                        setState(() => _selectedQuest = questState.quests.first);
                      }
                    },
                  ),
                ),
                Positioned(
                  top: 100,
                  right: 90,
                  child: _buildMapPin(
                    questTitle: 'Bolinao Lighthouse',
                    onTap: () {
                      if (questState.quests.length > 1) {
                        setState(() => _selectedQuest = questState.quests[1]);
                      }
                    },
                  ),
                ),
                Positioned(
                  bottom: 220,
                  left: 160,
                  child: _buildMapPin(
                    questTitle: 'Manaoag Shrine',
                    onTap: () {
                      if (questState.quests.length > 2) {
                        setState(() => _selectedQuest = questState.quests[2]);
                      }
                    },
                  ),
                ),
              ],
            ),
          ),

          // MapLibre Vector Map Overlay (renders if GL initialized properly)
          if (!_mapError)
            MapLibreMap(
              styleString: MapConfig.vectorStyleUrl,
              initialCameraPosition: const CameraPosition(
                target: LatLng(MapConfig.pangasinanLat, MapConfig.pangasinanLng),
                zoom: MapConfig.defaultZoom,
              ),
              onMapCreated: _onMapCreated,
              myLocationEnabled: false,
              trackCameraPosition: true,
              onStyleLoadedCallback: () {
                _syncQuestMarkers();
              },
            ),

          // Map Control Legend Overlay
          Positioned(
            top: 16,
            left: 16,
            right: 16,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.95),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: const Color(0xFFD5C4AC).withValues(alpha: 0.5)),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.08),
                    blurRadius: 10,
                    offset: const Offset(0, 4),
                  ),
                ],
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.map_rounded, color: Color(0xFF7D5800), size: 20),
                      const SizedBox(width: 8),
                      Text(
                        'Pangasinan Vector Map',
                        style: GoogleFonts.plusJakartaSans(
                          color: const Color(0xFF582F0E),
                          fontWeight: FontWeight.bold,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: const Color(0xFFBEEAD1),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      '${questState.quests.length} Destinations',
                      style: GoogleFonts.plusJakartaSans(
                        color: const Color(0xFF436B58),
                        fontWeight: FontWeight.bold,
                        fontSize: 10,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),

          // Selected Quest Bottom Sheet Drawer
          if (_selectedQuest != null)
            Positioned(
              bottom: 20,
              left: 16,
              right: 16,
              child: Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: const Color(0xFFFFB703), width: 1.5),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.12),
                      blurRadius: 16,
                      offset: const Offset(0, 4),
                    ),
                  ],
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                          decoration: BoxDecoration(
                            color: const Color(0xFF3F6653).withValues(alpha: 0.15),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Text(
                            _selectedQuest!.category.toUpperCase(),
                            style: GoogleFonts.plusJakartaSans(
                              color: const Color(0xFF3F6653),
                              fontWeight: FontWeight.bold,
                              fontSize: 10,
                            ),
                          ),
                        ),
                        IconButton(
                          icon: const Icon(Icons.close, size: 20, color: Color(0xFF837560)),
                          onPressed: () => setState(() => _selectedQuest = null),
                        ),
                      ],
                    ),
                    Text(
                      _selectedQuest!.title,
                      style: GoogleFonts.epilogue(
                        color: const Color(0xFF582F0E),
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        const Icon(Icons.location_on, color: Color(0xFF7D5800), size: 14),
                        const SizedBox(width: 4),
                        Expanded(
                          child: Text(
                            _selectedQuest!.locationName,
                            overflow: TextOverflow.ellipsis,
                            style: GoogleFonts.plusJakartaSans(color: const Color(0xFF514532), fontSize: 13),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          '+${_selectedQuest!.rewardPoints} PTS Reward',
                          style: GoogleFonts.plusJakartaSans(
                            color: const Color(0xFF7D5800),
                            fontWeight: FontWeight.bold,
                            fontSize: 14,
                          ),
                        ),
                        ElevatedButton(
                          onPressed: () => context.push('/quests/${_selectedQuest!.id}', extra: _selectedQuest),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFFFFB703),
                            foregroundColor: const Color(0xFF6B4B00),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                          ),
                          child: Text('View Quest', style: GoogleFonts.epilogue(fontWeight: FontWeight.bold)),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildMapPin({
    required String questTitle,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: const Color(0xFFFFB703),
              shape: BoxShape.circle,
              border: Border.all(color: const Color(0xFF582F0E), width: 2.5),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withValues(alpha: 0.25),
                  blurRadius: 8,
                  offset: const Offset(0, 3),
                ),
              ],
            ),
            child: const Icon(Icons.place_rounded, color: Color(0xFF582F0E), size: 24),
          ),
          const SizedBox(height: 4),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: 0.8),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              questTitle,
              style: GoogleFonts.plusJakartaSans(color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold),
            ),
          ),
        ],
      ),
    );
  }
}
