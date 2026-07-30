import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

class VoteScreen extends StatefulWidget {
  const VoteScreen({super.key});

  @override
  State<VoteScreen> createState() => _VoteScreenState();
}

class _VoteScreenState extends State<VoteScreen> {
  final Map<String, int> _votes = {
    'prop_1': 142,
    'prop_2': 98,
    'prop_3': 210,
  };

  final Map<String, bool> _hasVoted = {};

  void _castVote(String propId) {
    if (_hasVoted[propId] == true) return;
    setState(() {
      _votes[propId] = (_votes[propId] ?? 0) + 1;
      _hasVoted[propId] = true;
    });

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          'Vote cast successfully! Thank you for participating in Pangasinan Tourism Governance.',
          style: GoogleFonts.plusJakartaSans(),
        ),
        backgroundColor: const Color(0xFF2D6A4F),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFFAF9F5),
      appBar: AppBar(
        backgroundColor: const Color(0xFFFAF9F5),
        elevation: 0,
        scrolledUnderElevation: 0,
        title: Text(
          'Destination Governance',
          style: GoogleFonts.epilogue(
            color: const Color(0xFF582F0E),
            fontSize: 20,
            fontWeight: FontWeight.bold,
          ),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // DAO Header Card
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: const Color(0xFFFFB703)),
                boxShadow: [
                  BoxShadow(
                    color: const Color(0xFFFFB703).withValues(alpha: 0.15),
                    blurRadius: 12,
                    offset: const Offset(0, 4),
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        'TOURISM DAO VOTING',
                        style: GoogleFonts.plusJakartaSans(
                          color: const Color(0xFF7D5800),
                          fontSize: 11,
                          fontWeight: FontWeight.bold,
                          letterSpacing: 1.0,
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: const Color(0xFF3F6653).withValues(alpha: 0.15),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(
                          'ACTIVE PROPOSALS',
                          style: GoogleFonts.plusJakartaSans(
                            color: const Color(0xFF3F6653),
                            fontSize: 10,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Vote on Next Pangasinan Quests',
                    style: GoogleFonts.epilogue(
                      color: const Color(0xFF582F0E),
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'Participate in community governance to select which historic and eco-tourism sites should be featured in upcoming quest updates.',
                    style: GoogleFonts.plusJakartaSans(
                      color: const Color(0xFF514532),
                      fontSize: 13,
                      height: 1.4,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),

            Text(
              'Community Proposals',
              style: GoogleFonts.epilogue(
                color: const Color(0xFF0D1B2A),
                fontSize: 18,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 12),

            _buildProposalCard(
              id: 'prop_3',
              title: 'Add Patar White Beach Eco Trail',
              location: 'Bolinao, Pangasinan',
              description: 'Add an eco-quest covering the coastal rock formations and white sand beach trail in Bolinao.',
              category: 'ECO-TOURISM',
            ),
            const SizedBox(height: 12),
            _buildProposalCard(
              id: 'prop_1',
              title: 'Add Tayug Sunflower Maze Quest',
              location: 'Tayug, Pangasinan',
              description: 'Create an interactive agricultural quest at the famous sunflower maze park in eastern Pangasinan.',
              category: 'AGRI-TOURISM',
            ),
            const SizedBox(height: 12),
            _buildProposalCard(
              id: 'prop_2',
              title: 'Add San Fabian Beach Heritage Trail',
              location: 'San Fabian, Pangasinan',
              description: 'Feature WWII historic landing sites along San Fabian beach.',
              category: 'HERITAGE',
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildProposalCard({
    required String id,
    required String title,
    required String location,
    required String description,
    required String category,
  }) {
    final votesCount = _votes[id] ?? 0;
    final voted = _hasVoted[id] == true;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFD5C4AC).withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: const Color(0xFFEFEEEA),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  category,
                  style: GoogleFonts.plusJakartaSans(
                    color: const Color(0xFF837560),
                    fontSize: 9,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              Row(
                children: [
                  const Icon(Icons.how_to_vote_rounded, color: Color(0xFF7D5800), size: 16),
                  const SizedBox(width: 4),
                  Text(
                    '$votesCount Votes',
                    style: GoogleFonts.plusJakartaSans(
                      color: const Color(0xFF7D5800),
                      fontWeight: FontWeight.bold,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            title,
            style: GoogleFonts.epilogue(
              color: const Color(0xFF582F0E),
              fontSize: 16,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            location,
            style: GoogleFonts.plusJakartaSans(color: const Color(0xFF837560), fontSize: 12),
          ),
          const SizedBox(height: 8),
          Text(
            description,
            style: GoogleFonts.plusJakartaSans(color: const Color(0xFF514532), fontSize: 13, height: 1.4),
          ),
          const SizedBox(height: 14),
          ElevatedButton.icon(
            onPressed: voted ? null : () => _castVote(id),
            icon: Icon(voted ? Icons.check : Icons.thumb_up_alt_outlined),
            label: Text(
              voted ? 'Vote Cast' : 'Vote for Proposal',
              style: GoogleFonts.epilogue(fontWeight: FontWeight.bold),
            ),
            style: ElevatedButton.styleFrom(
              minimumSize: const Size.fromHeight(42),
              backgroundColor: voted ? const Color(0xFF3F6653) : const Color(0xFFFFB703),
              foregroundColor: voted ? Colors.white : const Color(0xFF6B4B00),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
          ),
        ],
      ),
    );
  }
}
