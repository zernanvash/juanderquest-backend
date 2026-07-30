import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:maplibre_gl/maplibre_gl.dart';
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

  // OpenMapTiles / MapLibre style JSON URL
  static const String openMapTilesStyleUrl = 'https://demotiles.maplibre.org/style.json';

  // Pangasinan Center Coordinates
  static const LatLng _pangasinanCenter = LatLng(16.0350, 120.3330);

  void _onMapCreated(MapLibreMapController controller) {
    _mapController = controller;
    _addQuestMarkers();
  }

  void _addQuestMarkers() {
    if (_mapController == null) return;

    final quests = ref.read(questProvider).quests;

    for (int i = 0; i < quests.length; i++) {
      final quest = quests[i];
      _mapController!.addCircle(
        CircleOptions(
          geometry: LatLng(quest.gpsLat, quest.gpsLng),
          circleColor: '#FFB703',
          circleRadius: 12.0,
          circleStrokeWidth: 3.0,
          circleStrokeColor: '#582F0E',
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
  }

  @override
  Widget build(BuildContext context) {
    final questState = ref.watch(questProvider);

    return Scaffold(
      backgroundColor: const Color(0xFFFAF9F5),
      appBar: AppBar(
        backgroundColor: const Color(0xFFFAF9F5),
        elevation: 0,
        scrolledUnderElevation: 0,
        title: Text(
          'Pangasinan Quest Map',
          style: GoogleFonts.epilogue(
            color: const Color(0xFF582F0E),
            fontSize: 20,
            fontWeight: FontWeight.bold,
          ),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.history_rounded, color: Color(0xFF582F0E)),
            tooltip: 'Submissions History',
            onPressed: () => context.push('/history'),
          ),
        ],
      ),
      body: Stack(
        children: [
          // Maplibre Vector Map Canvas (OpenMapTiles Provider)
          MapLibreMap(
            styleString: openMapTilesStyleUrl,
            initialCameraPosition: const CameraPosition(
              target: _pangasinanCenter,
              zoom: 10.0,
            ),
            onMapCreated: _onMapCreated,
            myLocationEnabled: true,
            trackCameraPosition: true,
          ),

          // Map Control Legend Overlay (Stitch Integrated Style)
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
                        'OpenMapTiles Provider',
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
                      '${questState.quests.length} Quest Markers',
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

          // Selected Quest Details Drawer Card
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
                        Text(
                          _selectedQuest!.locationName,
                          style: GoogleFonts.plusJakartaSans(color: const Color(0xFF514532), fontSize: 13),
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
}
