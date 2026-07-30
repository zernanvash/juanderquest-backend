import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/network/api_client.dart';
import '../../auth/providers/auth_provider.dart';
import '../models/quest_model.dart';

class QuestState {
  final List<QuestModel> quests;
  final bool isLoading;
  final String? error;
  final String? selectedCategory;

  QuestState({
    this.quests = const [],
    this.isLoading = false,
    this.error,
    this.selectedCategory,
  });
}

class QuestNotifier extends StateNotifier<QuestState> {
  final ApiClient _apiClient;

  QuestNotifier(this._apiClient) : super(QuestState());

  Future<void> fetchQuests({String? category}) async {
    state = QuestState(isLoading: true, selectedCategory: category);
    try {
      final query = category != null ? '?category=$category' : '';
      final response = await _apiClient.dio.get('/quests$query');

      if (response.statusCode == 200 && response.data['success'] == true) {
        final list = (response.data['data'] as List)
            .map((q) => QuestModel.fromJson(q))
            .toList();
        state = QuestState(quests: list, selectedCategory: category);
      }
    } catch (e) {
      // Fallback mock quests if server unreachable
      final mockList = [
        QuestModel(
          id: 'q1111111-1111-1111-1111-111111111111',
          title: 'Hundred Islands Eco Trek',
          description: "Visit Governor's Island viewing deck in Alaminos City and scan the eco-marker.",
          category: 'eco',
          locationName: 'Alaminos City, Pangasinan',
          gpsLat: 16.2063,
          gpsLng: 119.9706,
          radiusMeters: 150,
          rewardPoints: 50,
          markerCode: 'MARKER_HUNDRED_ISLANDS_01',
          markerImageUrl: 'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/hundred_islands.png',
        ),
        QuestModel(
          id: 'q2222222-2222-2222-2222-222222222222',
          title: 'Bolinao Lighthouse Cultural Heritage',
          description: 'Explore Cape Bolinao Lighthouse built in 1905 and scan the heritage marker.',
          category: 'cultural',
          locationName: 'Bolinao, Pangasinan',
          gpsLat: 16.3885,
          gpsLng: 119.9095,
          radiusMeters: 200,
          rewardPoints: 75,
          markerCode: 'MARKER_BOLINAO_LIGHTHOUSE_01',
          markerImageUrl: 'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/bolinao_lighthouse.png',
        ),
      ];

      final filtered = category != null
          ? mockList.where((q) => q.category == category).toList()
          : mockList;

      state = QuestState(quests: filtered, selectedCategory: category);
    }
  }
}

final questProvider = StateNotifierProvider<QuestNotifier, QuestState>((ref) {
  final apiClient = ref.watch(apiClientProvider);
  return QuestNotifier(apiClient);
});
