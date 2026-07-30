class QuestModel {
  final String id;
  final String title;
  final String description;
  final String category;
  final String locationName;
  final double gpsLat;
  final double gpsLng;
  final int radiusMeters;
  final int rewardPoints;
  final String markerCode;
  final String markerImageUrl;

  QuestModel({
    required this.id,
    required this.title,
    required this.description,
    required this.category,
    required this.locationName,
    required this.gpsLat,
    required this.gpsLng,
    required this.radiusMeters,
    required this.rewardPoints,
    required this.markerCode,
    required this.markerImageUrl,
  });

  factory QuestModel.fromJson(Map<String, dynamic> json) {
    return QuestModel(
      id: json['id'] ?? '',
      title: json['title'] ?? '',
      description: json['description'] ?? '',
      category: json['category'] ?? 'eco',
      locationName: json['location_name'] ?? 'Pangasinan',
      gpsLat: (json['gps_lat'] as num?)?.toDouble() ?? 0.0,
      gpsLng: (json['gps_lng'] as num?)?.toDouble() ?? 0.0,
      radiusMeters: json['radius_meters'] ?? 200,
      rewardPoints: json['reward_points'] ?? 50,
      markerCode: json['marker_code'] ?? '',
      markerImageUrl: json['marker_image_url'] ?? '',
    );
  }
}
