import Foundation
import Testing

@testable import OakApp

/// `HistoryListViewModel` against `FakeHistoryService` (history-and-teams.md
/// M-HIST-US-2): loading, server-side search (`?q=`) and format filter (`?format=`),
/// and the optimistic pin / rename / delete mutations. The view model is
/// `@MainActor`, so the suite is too.
@MainActor
struct HistoryListViewModelTests {

  // MARK: Helpers

  private func summary(
    id: String,
    title: String = "Conversation",
    format: Format = .scarletViolet,
    pinned: Bool = false,
    updatedAt: Int64 = 1_000
  ) -> ConversationSummary {
    ConversationSummary(id: id, title: title, format: format, pinned: pinned, updatedAt: updatedAt)
  }

  // MARK: Loading

  @Test
  func reloadPopulatesConversations() async {
    let fake = FakeHistoryService()
    fake.listResult = .success([summary(id: "a"), summary(id: "b")])
    let vm = HistoryListViewModel(history: fake)

    await vm.reload()

    #expect(vm.conversations.map(\.id) == ["a", "b"])
    #expect(fake.listCount == 1)
    #expect(vm.errorMessage == nil)
    #expect(vm.isLoading == false)
  }

  @Test
  func reloadSurfacesErrorAndKeepsPriorList() async {
    let fake = FakeHistoryService()
    fake.listResult = .success([summary(id: "a")])
    let vm = HistoryListViewModel(history: fake)
    await vm.reload()

    fake.listResult = .failure(.transport(underlying: "URLError.-1009"))
    await vm.reload()

    #expect(vm.conversations.map(\.id) == ["a"])  // prior list preserved
    #expect(vm.errorMessage == HistoryListViewModel.connectionMessage)
  }

  // MARK: Search

  @Test
  func searchSendsTrimmedQuery() async {
    let fake = FakeHistoryService()
    let vm = HistoryListViewModel(history: fake)
    vm.searchQuery = "  garchomp  "

    await vm.search()

    #expect(fake.lastListQuery == "garchomp")
  }

  @Test
  func blankSearchSendsNilQuery() async {
    let fake = FakeHistoryService()
    let vm = HistoryListViewModel(history: fake)
    vm.searchQuery = "   "

    await vm.reload()

    #expect(fake.lastListQuery == nil)
  }

  // MARK: Format filter

  @Test
  func setFormatFilterReloadsWithFormat() async {
    let fake = FakeHistoryService()
    let vm = HistoryListViewModel(history: fake)

    await vm.setFormatFilter(.champions)

    #expect(vm.formatFilter == .champions)
    #expect(fake.lastListFormat == .champions)
    #expect(fake.listCount == 1)
  }

  @Test
  func setFormatFilterNoOpWhenUnchanged() async {
    let fake = FakeHistoryService()
    let vm = HistoryListViewModel(history: fake)

    // Default filter is already nil ("all"), so selecting "all" again must not refetch.
    await vm.setFormatFilter(nil)

    #expect(fake.listCount == 0)
  }

  // MARK: Pin

  @Test
  func togglePinPersistsAndUpdatesLocallyAndResorts() async {
    let fake = FakeHistoryService()
    fake.listResult = .success([
      summary(id: "a", pinned: false, updatedAt: 200),
      summary(id: "b", pinned: false, updatedAt: 100),
    ])
    let vm = HistoryListViewModel(history: fake)
    await vm.reload()

    // Pin the lower (older) row: it should persist and move to the top.
    await vm.togglePin(vm.conversations[1])

    #expect(fake.lastPinnedId == "b")
    #expect(fake.lastPinnedValue == true)
    #expect(vm.conversations.first?.id == "b")
    #expect(vm.conversations.first?.pinned == true)
  }

  @Test
  func togglePinRevertsOnFailure() async {
    let fake = FakeHistoryService()
    fake.listResult = .success([summary(id: "a", pinned: false)])
    let vm = HistoryListViewModel(history: fake)
    await vm.reload()
    fake.setPinnedError = .transport(underlying: "URLError.-1009")

    await vm.togglePin(vm.conversations[0])

    #expect(vm.conversations[0].pinned == false)  // reverted
    #expect(vm.errorMessage == HistoryListViewModel.connectionMessage)
  }

  // MARK: Rename

  @Test
  func renamePersistsAndUpdatesLocal() async {
    let fake = FakeHistoryService()
    fake.listResult = .success([summary(id: "a", title: "Old")])
    let vm = HistoryListViewModel(history: fake)
    await vm.reload()

    await vm.rename(vm.conversations[0], to: "  New title  ")

    #expect(fake.lastRenamedId == "a")
    #expect(fake.lastRenamedTitle == "New title")
    #expect(vm.conversations[0].title == "New title")
  }

  @Test
  func renameIgnoresEmptyOrUnchanged() async {
    let fake = FakeHistoryService()
    fake.listResult = .success([summary(id: "a", title: "Same")])
    let vm = HistoryListViewModel(history: fake)
    await vm.reload()

    await vm.rename(vm.conversations[0], to: "   ")     // empty after trim
    await vm.rename(vm.conversations[0], to: "Same")    // unchanged

    #expect(fake.renameCount == 0)
    #expect(vm.conversations[0].title == "Same")
  }

  // MARK: Delete

  @Test
  func deleteRemovesOptimistically() async {
    let fake = FakeHistoryService()
    fake.listResult = .success([summary(id: "a"), summary(id: "b")])
    let vm = HistoryListViewModel(history: fake)
    await vm.reload()

    await vm.delete(vm.conversations[0])

    #expect(fake.lastDeletedId == "a")
    #expect(vm.conversations.map(\.id) == ["b"])
    #expect(vm.errorMessage == nil)
  }

  @Test
  func deleteTreats404AsSuccess() async {
    let fake = FakeHistoryService()
    fake.listResult = .success([summary(id: "a")])
    let vm = HistoryListViewModel(history: fake)
    await vm.reload()
    fake.deleteError = .http(status: 404, code: "not_found", message: "gone")

    await vm.delete(vm.conversations[0])

    #expect(vm.conversations.isEmpty)              // stays removed (idempotent)
    #expect(vm.errorMessage == nil)
  }

  @Test
  func deleteRevertsOnRealFailure() async {
    let fake = FakeHistoryService()
    fake.listResult = .success([summary(id: "a")])
    let vm = HistoryListViewModel(history: fake)
    await vm.reload()
    fake.deleteError = .transport(underlying: "URLError.-1009")

    await vm.delete(vm.conversations[0])

    #expect(vm.conversations.map(\.id) == ["a"])   // restored
    #expect(vm.errorMessage == HistoryListViewModel.connectionMessage)
  }
}
