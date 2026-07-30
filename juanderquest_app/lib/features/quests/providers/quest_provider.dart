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
      } else {
        state = QuestState(error: 'Failed to load quests', selectedCategory: category);
      }
    } catch (e) {
      state = QuestState(error: 'Could not connect to server', selectedCategory: category);
    }
  }
}

final questProvider = StateNotifierProvider<QuestNotifier, QuestState>((ref) {
  final apiClient = ref.watch(apiClientProvider);
  return QuestNotifier(apiClient);
});
