import SwiftUI

// The Effects and Power-ups groups of the settings sheet (docs/MILESTONE4.md
// §9). Each effect row is a toggle that expands with its own controls when on.
// `effects` and `powerups` are sent whole, as the contract requires.

struct EffectsSettingsSection: View {
    @EnvironmentObject private var room: RoomStore
    var settings: RoomSettings

    private var effects: EffectsSettings { settings.effects }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            greyscaleRow
            SettingsHairline()
            blurRow
            SettingsHairline()
            focusRow
            SettingsHairline()
            zoomRow
        }
    }

    // MARK: - Greyscale

    private var greyscaleRow: some View {
        SettingsToggleRow(
            title: "Greyscale",
            isOn: enabledBinding(get: { $0.greyscale.enabled }, set: { $0.greyscale.enabled = $1 }),
            identifier: "toggle-greyscale"
        ) {
            VStack(alignment: .leading, spacing: 10) {
                SettingsInlineLabel(text: "Trigger")
                ChoiceChips(
                    values: EffectTrigger.allCases,
                    selected: effects.greyscale.trigger,
                    label: { $0.label }
                ) { trigger in
                    update { $0.greyscale.trigger = trigger }
                }
                HStack(spacing: 12) {
                    SettingsInlineLabel(text: "After")
                    Spacer(minLength: 8)
                    SettingsStepper(
                        value: effects.greyscale.after,
                        range: EffectsSettings.afterRange,
                        decreaseLabel: "Start sooner",
                        increaseLabel: "Start later"
                    ) { after in update { $0.greyscale.after = after } }
                }
            }
        }
    }

    // MARK: - Blur

    private var blurRow: some View {
        SettingsToggleRow(
            title: "Blur",
            isOn: enabledBinding(get: { $0.blur.enabled }, set: { $0.blur.enabled = $1 }),
            identifier: "toggle-blur"
        ) {
            VStack(alignment: .leading, spacing: 10) {
                SettingsInlineLabel(text: "Trigger")
                ChoiceChips(
                    values: EffectTrigger.allCases,
                    selected: effects.blur.trigger,
                    label: { $0.label }
                ) { trigger in
                    update { $0.blur.trigger = trigger }
                }
                HStack(spacing: 12) {
                    SettingsInlineLabel(text: "After")
                    Spacer(minLength: 8)
                    SettingsStepper(
                        value: effects.blur.after,
                        range: EffectsSettings.afterRange,
                        decreaseLabel: "Start sooner",
                        increaseLabel: "Start later"
                    ) { after in update { $0.blur.after = after } }
                }
                SettingsInlineLabel(text: "Strength")
                ChoiceChips(
                    values: BlurStrength.allCases,
                    selected: effects.blur.strength,
                    label: { $0.label }
                ) { strength in
                    update { $0.blur.strength = strength }
                }
                if effects.needsBlurAfterGreyscale {
                    Text("Blur has to start after greyscale.")
                        .font(.flCaption)
                        .foregroundStyle(Palette.text3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: - Focus

    private var focusRow: some View {
        SettingsToggleRow(
            title: "Focus",
            isOn: enabledBinding(get: { $0.focus.enabled }, set: { $0.focus.enabled = $1 }),
            identifier: "toggle-focus"
        ) {
            VStack(alignment: .leading, spacing: 10) {
                ChoiceChips(
                    values: EffectFrequency.allCases,
                    selected: effects.focus.frequency,
                    label: { $0.label }
                ) { frequency in
                    update { $0.focus.frequency = frequency }
                }
                SettingsInlineLabel(text: "Span")
                spanChips(selected: effects.focus.span) { span in
                    update { $0.focus.span = span }
                }
            }
        }
    }

    // MARK: - Zoom

    private var zoomRow: some View {
        SettingsToggleRow(
            title: "Zoom-out",
            isOn: enabledBinding(get: { $0.zoom.enabled }, set: { $0.zoom.enabled = $1 }),
            identifier: "toggle-zoom"
        ) {
            VStack(alignment: .leading, spacing: 10) {
                ChoiceChips(
                    values: EffectFrequency.allCases,
                    selected: effects.zoom.frequency,
                    label: { $0.label }
                ) { frequency in
                    update { $0.zoom.frequency = frequency }
                }
                SettingsInlineLabel(text: "Span")
                spanChips(selected: effects.zoom.span) { span in
                    update { $0.zoom.span = span }
                }
                SettingsInlineLabel(text: "Zoom")
                ChoiceChips(
                    values: EffectsSettings.scales,
                    selected: effects.zoom.scale,
                    label: { "\($0)×" }
                ) { scale in
                    update { $0.zoom.scale = scale }
                }
            }
        }
    }

    private func spanChips(selected: Int, action: @escaping (Int) -> Void) -> some View {
        ChoiceChips(values: EffectsSettings.spans, selected: selected, label: { "\($0)%" }, action: action)
    }

    // MARK: - Sending

    private func enabledBinding(
        get: @escaping (EffectsSettings) -> Bool,
        set: @escaping (inout EffectsSettings, Bool) -> Void
    ) -> Binding<Bool> {
        Binding(
            get: { get(effects) },
            set: { value in update { set(&$0, value) } }
        )
    }

    /// Sends the whole `effects` object with the change applied, normalized so
    /// the server's validation rules are always met.
    private func update(_ transform: (inout EffectsSettings) -> Void) {
        var next = effects
        transform(&next)
        room.send(.settings(effects: next.validated()))
        Haptics.tick()
    }
}

struct PowerupSettingsSection: View {
    @EnvironmentObject private var room: RoomStore
    var settings: RoomSettings

    private var powerups: PowerupSettings { settings.powerups }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsToggleRow(
                title: "50/50",
                isOn: fiftyFiftyBinding,
                identifier: "toggle-fifty-fifty"
            ) {
                HStack(spacing: 12) {
                    SettingsInlineLabel(text: "Earn after")
                    Spacer(minLength: 8)
                    SettingsStepper(
                        value: powerups.fiftyFifty.after,
                        range: EffectsSettings.afterRange,
                        decreaseLabel: "Earn sooner",
                        increaseLabel: "Earn later"
                    ) { after in
                        var next = powerups
                        next.fiftyFifty.after = after
                        room.send(.settings(powerups: next.validated()))
                        Haptics.tick()
                    }
                }
            }
            SettingsHairline()
            SettingsToggleRow(
                title: "Shop",
                isOn: shopBinding,
                caption: shopCaption,
                identifier: "toggle-shop"
            ) {
                EmptyView()
            }
        }
    }

    private var shopCaption: String {
        let dd = ShopItem.doubleDown
        let sh = ShopItem.shield
        let ff = ShopItem.fiftyFifty
        return "\(dd.name) \(dd.defaultPrice) · \(sh.name) \(sh.defaultPrice) · \(ff.name) \(ff.defaultPrice)"
    }

    private var fiftyFiftyBinding: Binding<Bool> {
        Binding(
            get: { powerups.fiftyFifty.enabled },
            set: { value in
                var next = powerups
                next.fiftyFifty.enabled = value
                room.send(.settings(powerups: next.validated()))
                Haptics.tick()
            }
        )
    }

    private var shopBinding: Binding<Bool> {
        Binding(
            get: { powerups.shop.enabled },
            set: { value in
                var next = powerups
                next.shop.enabled = value
                room.send(.settings(powerups: next.validated()))
                Haptics.tick()
            }
        )
    }
}
