import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import '../../quests/providers/quest_provider.dart';
import '../../quests/models/quest_model.dart';

class MapViewScreen extends ConsumerStatefulWidget {
  const MapViewScreen({super.key});

  @override
  ConsumerState<MapViewScreen> createState() => _MapViewScreenState();
}

class _MapViewScreenState extends ConsumerState<MapViewScreen> {
  QuestModel? _selectedQuest;

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
            tooltip: 'Submission History',
            onPressed: () => context.push('/history'),
          ),
        ],
      ),
      body: Stack(
        children: [
          // Map Canvas Placeholder (Pangasinan Tourist Map)
          Container(
            width: double.infinity,
            height: double.infinity,
            decoration: const BoxDecoration(
              color: Color(0xFFE9E8E4),
              image: DecorationImage(
                image: AssetImage('assets/images/pangasinan_banner.png'),
                fit: BoxFit.cover,
                colorFilter: ColorFilter.mode(Colors.black26, BlendMode.darken),
              ),
            ),
            child: Stack(
              children: [
                // Interactive Quest Map Pins
                Positioned(
                  top: 180,
                  left: 120,
                  child: _buildMapPin(
                    questTitle: 'Hundred Islands Eco Trek',
                    category: 'eco',
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
                    category: 'cultural',
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
                    category: 'cultural',
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

          // Map Legend Banner
          Positioned(
            top: 16,
            left: 16,
            right: 16,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.95),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: const Color(0xFFD5C4AC).withValues(alpha: 0.4)),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.05),
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
                        'Pangasinan Region',
                        style: GoogleFonts.plusJakartaSans(
                          color: const Color(0xFF582F0E),
                          fontWeight: FontWeight.bold,
                          fontSize: 13,
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
                      '${questState.quests.length} Active Destinations',
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

          // Selected Quest Card Bottom Sheet
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
                  border: Border.all(color: const Color(0xFFFFB703)),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.1),
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

  Widget _buildMapPin({
    required String questTitle,
    required String category,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: Column(
        children: [
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: const Color(0xFFFFB703),
              shape: BoxShape.circle,
              border: Border.all(color: Colors.white, width: 2.5),
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
              color: Colors.black.withValues(alpha: 0.75),
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
