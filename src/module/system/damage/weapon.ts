import { ActorPF2e } from "@actor";
import { DamageDicePF2e, ModifierPF2e, createAttributeModifier } from "@actor/modifiers.ts";
import { ATTRIBUTE_ABBREVIATIONS } from "@actor/values.ts";
import { MeleePF2e, WeaponPF2e } from "@item";
import type { NPCAttackDamage } from "@item/melee/data.ts";
import { RUNE_DATA, getPropertyRuneDice, getPropertyRuneModifierAdjustments } from "@item/physical/runes.ts";
import type { WeaponDamage } from "@item/weapon/data.ts";
import type { ZeroToThree } from "@module/data.ts";
import { RollNotePF2e } from "@module/notes.ts";
import {
    extractDamageAlterations,
    extractDamageDice,
    extractModifierAdjustments,
    extractModifiers,
    processDamageCategoryStacking,
} from "@module/rules/helpers.ts";
import { CritSpecEffect, PotencySynthetic, StrikingSynthetic } from "@module/rules/synthetics.ts";
import { DEGREE_OF_SUCCESS } from "@system/degree-of-success.ts";
import { mapValues, objectHasKey, sluggify } from "@util";
import * as R from "remeda";
import { DamageModifierDialog } from "./dialog.ts";
import { createDamageFormula, parseTermsFromSimpleFormula } from "./formula.ts";
import {
    DamageCategoryUnique,
    DamageDamageContext,
    DamageDieSize,
    DamageFormulaData,
    MaterialDamageEffect,
    WeaponBaseDamageData,
    WeaponDamageTemplate,
} from "./types.ts";

class WeaponDamagePF2e {
    static async fromNPCAttack({
        attack,
        actor,
        context,
    }: NPCStrikeCalculateParams): Promise<WeaponDamageTemplate | null> {
        const baseDamage = attack.baseDamage;
        const secondaryInstances = Object.values(attack.system.damageRolls)
            .map(this.npcDamageToWeaponDamage)
            .filter((d) => !R.isDeepEqual(d, baseDamage));

        // Collect damage dice and modifiers from secondary damage instances
        const damageDice: DamageDicePF2e[] = [];
        const modifiers: ModifierPF2e[] = [];
        const labelFromCategory = {
            null: "",
            persistent: "",
            precision: "PF2E.Damage.Precision",
            splash: attack.system.traits.value.some((t) => t.startsWith("scatter-"))
                ? "PF2E.TraitScatter"
                : "PF2E.TraitSplash",
        };
        for (const instance of secondaryInstances) {
            const { damageType } = instance;
            if (instance.dice > 0 && instance.die) {
                damageDice.push(
                    new DamageDicePF2e({
                        slug: "base",
                        label: labelFromCategory[instance.category ?? "null"],
                        selector: `${attack.id}-damage`,
                        diceNumber: instance.dice,
                        dieSize: instance.die,
                        damageType: instance.damageType,
                        category: instance.category,
                    }),
                );
            }
            if (instance.modifier) {
                modifiers.push(
                    new ModifierPF2e({
                        slug: "base",
                        label: labelFromCategory[instance.category ?? "null"],
                        modifier: instance.modifier,
                        damageType,
                        damageCategory: instance.category,
                    }),
                );
            }
        }

        return WeaponDamagePF2e.calculate({
            weapon: attack,
            actor,
            damageDice,
            modifiers,
            context,
        });
    }

    /** Calculates the damage a weapon will deal when striking. Performs side effects, so make sure to pass a clone */
    static async calculate({
        weapon,
        actor,
        damageDice = [],
        modifiers = [],
        weaponPotency = null,
        context,
    }: WeaponDamageCalculateParams): Promise<WeaponDamageTemplate | null> {
        const baseDamage = weapon.baseDamage;
        const { domains, options } = context;
        if (baseDamage.die === null && baseDamage.modifier > 0) {
            baseDamage.dice = 0;
        } else if (!weapon.dealsDamage) {
            return null;
        }

        const weaponTraits = weapon.system.traits.value;
        // NPC attacks have precious materials as quasi-traits: separate for IWR processing and separate display in chat
        const materialTraits = weapon.isOfType("melee")
            ? weapon.system.traits.value.filter(
                  (t): t is MaterialDamageEffect => t in CONFIG.PF2E.materialDamageEffects,
              )
            : [];

        // Always add all weapon traits to the options
        for (const trait of weaponTraits) {
            options.add(trait);
        }

        const isMelee = !!weapon.isMelee;
        options.add(isMelee ? "melee" : "ranged");

        // Determine ability modifier
        if (actor.isOfType("character") && weapon.isOfType("weapon")) {
            const attributeDomains = ATTRIBUTE_ABBREVIATIONS.map((a) => `${a}-damage`);
            const domain = domains.find((d) => attributeDomains.has(d));
            const strengthModValue = actor.abilities.str.mod;
            const modifierValue =
                domain === "str-damage"
                    ? strengthModValue < 0 || !weaponTraits.some((t) => t === "propulsive")
                        ? strengthModValue
                        : Math.floor(strengthModValue / 2)
                    : null;

            if (typeof modifierValue === "number") {
                const strModifier = createAttributeModifier({ actor, attribute: "str", domains, max: modifierValue });
                modifiers.push(strModifier);
            }
        }

        // Get just-in-time roll options from rule elements
        for (const rule of actor.rules.filter((r) => !r.ignored)) {
            rule.beforeRoll?.(domains, options);
        }

        // Splash damage
        const hasScatterTrait = weaponTraits.some((t) => t.startsWith("scatter-"));
        const splashDamage = weapon.isOfType("weapon")
            ? Number(weapon.system.splashDamage?.value) || (hasScatterTrait ? weapon.system.damage.dice || 0 : 0)
            : 0;
        if (splashDamage > 0) {
            const slug = hasScatterTrait ? "scatter" : "splash";
            const label = `PF2E.Trait${sluggify(slug, { camel: "bactrian" })}`;
            const modifier = new ModifierPF2e({
                slug,
                label,
                modifier: splashDamage,
                damageCategory: "splash",
            });
            modifiers.push(modifier);
        }

        if (weapon.isOfType("weapon")) {
            // Kickback trait
            if (weaponTraits.includes("kickback")) {
                // For NPCs, subtract from the base damage and add back as an untype bonus
                modifiers.push(
                    new ModifierPF2e({
                        slug: "kickback",
                        label: CONFIG.PF2E.weaponTraits.kickback,
                        modifier: 1,
                    }),
                );
            }

            // Bonus damage
            const bonusDamage = Number(weapon.system.bonusDamage?.value);
            if (bonusDamage > 0) {
                modifiers.push(
                    new ModifierPF2e({
                        label: "PF2E.WeaponBonusDamageLabel",
                        slug: "bonus",
                        modifier: bonusDamage,
                    }),
                );
            }

            // Custom damage
            const customDamage = weapon.system.property1;
            const normalDice = customDamage.dice ?? 0;
            if (normalDice > 0) {
                const damageType = customDamage.damageType || null;
                damageDice.push(
                    new DamageDicePF2e({
                        selector: `${weapon.id}-damage`,
                        slug: "custom",
                        label: "PF2E.WeaponCustomDamageLabel",
                        diceNumber: normalDice,
                        dieSize: customDamage.die,
                        damageType,
                    }),
                );
            }
            const critDice = customDamage.critDice ?? 0;
            if (critDice > 0) {
                const damageType = customDamage.critDamageType || null;
                damageDice.push(
                    new DamageDicePF2e({
                        selector: `${weapon.id}-damage`,
                        slug: "custom-critical",
                        label: "PF2E.WeaponCustomDamageLabel",
                        diceNumber: critDice,
                        dieSize: customDamage.critDie,
                        damageType,
                        critical: true,
                    }),
                );
            }
        }

        // Potency rune
        const potency = weaponPotency?.bonus ?? 0;

        // Critical specialization effects
        const critSpecEffect = ((): CritSpecEffect => {
            // If an alternate critical specialization effect is available, apply it only if there is also a
            // qualifying non-alternate
            const critSpecs = actor.synthetics.criticalSpecializations;
            const standard = critSpecs.standard.reduceRight(
                (result: CritSpecEffect | null, cs) => result ?? cs?.(weapon, options),
                null,
            );
            const alternate = critSpecs.alternate.reduceRight(
                (result: CritSpecEffect | null, cs) => result ?? cs?.(weapon, options),
                null,
            );

            return standard ? alternate ?? standard : [];
        })();

        if (critSpecEffect.length > 0) options.add("critical-specialization");
        modifiers.push(...critSpecEffect.filter((e): e is ModifierPF2e => e instanceof ModifierPF2e));
        damageDice.push(...critSpecEffect.filter((e): e is DamageDicePF2e => e instanceof DamageDicePF2e));

        // Property Runes
        const propertyRunes = weapon.system.runes.property;
        damageDice.push(...getPropertyRuneDice(propertyRunes, options));
        const propertyRuneAdjustments = getPropertyRuneModifierAdjustments(propertyRunes);
        const ignoredResistances = propertyRunes.flatMap(
            (r) => RUNE_DATA.weapon.property[r].damage?.ignoredResistances ?? [],
        );

        // Backstabber trait
        if (weaponTraits.some((t) => t === "backstabber") && options.has("target:condition:off-guard")) {
            const modifier = new ModifierPF2e({
                label: CONFIG.PF2E.weaponTraits.backstabber,
                slug: "backstabber",
                modifier: potency > 2 ? 2 : 1,
                damageCategory: "precision",
            });
            modifiers.push(modifier);
        }

        // If there are any striking synthetics, possibly upgrade the weapon's base damage dice
        const strikingSynthetic = domains
            .flatMap((key) => actor.synthetics.striking[key] ?? [])
            .filter((wp) => wp.predicate.test(options))
            .reduce(
                (highest: StrikingSynthetic | null, current) =>
                    highest && highest.bonus > current.bonus ? highest : current,
                null,
            );
        if (strikingSynthetic && baseDamage.die && weapon.isOfType("weapon")) {
            weapon.system.damage.dice = baseDamage.dice = Math.max(
                weapon.system.damage.dice,
                strikingSynthetic.bonus + 1,
            );
            weapon.system.runes.striking = Math.max(
                weapon.system.runes.striking,
                strikingSynthetic.bonus,
            ) as ZeroToThree;
        }

        // Get striking dice: the number of damage dice from a striking rune (or ABP devastating strikes)
        const strikingDice = weapon.isOfType("weapon")
            ? weapon.system.damage.dice - weapon._source.system.damage.dice
            : strikingSynthetic?.bonus ?? 0;

        // Deadly trait
        const traitLabels: Record<string, string> = CONFIG.PF2E.weaponTraits;
        const deadlyTraits = weaponTraits.filter((t) => t.startsWith("deadly-"));
        for (const slug of deadlyTraits) {
            const diceNumber = ((): number => {
                const baseNumber = Number(/-(\d)d\d{1,2}$/.exec(slug)?.at(1)) || 1;
                return strikingDice > 1 ? strikingDice * baseNumber : baseNumber;
            })();
            damageDice.push(
                new DamageDicePF2e({
                    selector: `${weapon.id}-damage`,
                    slug,
                    label: traitLabels[slug],
                    diceNumber,
                    dieSize: (/-\d?(d\d{1,2})$/.exec(slug)?.at(1) ?? baseDamage.die) as DamageDieSize,
                    critical: true,
                }),
            );
        }

        // Fatal trait
        for (const trait of weaponTraits.filter((t) => t.startsWith("fatal-d"))) {
            const dieSize = trait.substring(trait.indexOf("-") + 1) as DamageDieSize;
            damageDice.push(
                new DamageDicePF2e({
                    selector: `${weapon.id}-damage`,
                    slug: trait,
                    label: traitLabels[trait],
                    diceNumber: 1,
                    dieSize,
                    critical: true,
                    enabled: true,
                    override: { dieSize },
                }),
            );
        }

        // Forceful trait
        if (weaponTraits.some((t) => t === "forceful") && weapon.isOfType("weapon")) {
            modifiers.push(
                new ModifierPF2e({
                    slug: "forceful-second",
                    label: "PF2E.Item.Weapon.Forceful.Second",
                    modifier: weapon._source.system.damage.dice + strikingDice,
                    type: "circumstance",
                    ignored: true,
                }),
                new ModifierPF2e({
                    slug: "forceful-third",
                    label: "PF2E.Item.Weapon.Forceful.Third",
                    modifier: 2 * (weapon._source.system.damage.dice + strikingDice),
                    type: "circumstance",
                    ignored: true,
                }),
            );
        }

        // Twin trait
        if (weaponTraits.some((t) => t === "twin") && weapon.isOfType("weapon")) {
            modifiers.push(
                new ModifierPF2e({
                    slug: "twin-second",
                    label: "PF2E.Item.Weapon.Twin.SecondPlus",
                    modifier: weapon._source.system.damage.dice + strikingDice,
                    type: "circumstance",
                    ignored: true,
                }),
            );
        }

        // Venomous trait
        if (weaponTraits.some((t) => t === "venomous")) {
            const modifier = new ModifierPF2e({
                label: CONFIG.PF2E.weaponTraits.venomous,
                slug: "venomous",
                modifier: strikingDice > 1 ? 2 : 1,
                damageType: "poison",
                damageCategory: "persistent",
            });
            modifiers.push(modifier);
        }

        // Add roll notes to the context
        const runeNotes = propertyRunes.flatMap((r) => {
            const data = RUNE_DATA.weapon.property[r].damage?.notes ?? [];
            return data.map((d) => new RollNotePF2e({ selector: "strike-damage", ...d }));
        });
        context.notes = [runeNotes, critSpecEffect.filter((e): e is RollNotePF2e => e instanceof RollNotePF2e)].flat();

        // Accumulate damage-affecting precious materials
        const material = objectHasKey(CONFIG.PF2E.materialDamageEffects, weapon.system.material.type)
            ? weapon.system.material.type
            : null;
        const materials: Set<MaterialDamageEffect> = new Set([materialTraits, material ?? []].flat());
        for (const adjustment of actor.synthetics.strikeAdjustments) {
            adjustment.adjustDamageRoll?.(weapon, { materials });
        }

        for (const option of Array.from(materials).map((m) => `item:material:${m}`)) {
            options.add(option);
        }

        const baseUncategorized = ((): WeaponBaseDamageData | null => {
            const diceNumber = baseDamage.die ? baseDamage.dice : 0;
            return diceNumber > 0 || baseDamage.modifier > 0
                ? {
                      diceNumber,
                      dieSize: baseDamage.die,
                      modifier: baseDamage.modifier,
                      damageType: baseDamage.damageType,
                      category: "category" in baseDamage && baseDamage.category === "persistent" ? "persistent" : null,
                      materials: Array.from(materials),
                  }
                : null;
        })();

        const basePersistent = ((): WeaponBaseDamageData | null => {
            if (baseDamage.persistent?.faces) {
                return {
                    diceNumber: baseDamage.persistent.number,
                    dieSize: `d${baseDamage.persistent.faces}`,
                    damageType: baseDamage.persistent.type,
                    category: "persistent",
                };
            } else if (baseDamage.persistent?.number) {
                return {
                    modifier: baseDamage.persistent.number,
                    damageType: baseDamage.persistent.type,
                    category: "persistent",
                };
            }
            return null;
        })();
        if (!(baseUncategorized || basePersistent || splashDamage)) return null;

        const base = R.compact([baseUncategorized, basePersistent]);

        const adjustmentsRecord = actor.synthetics.modifierAdjustments;
        const alterationsRecord = actor.synthetics.damageAlterations;
        for (const modifier of modifiers) {
            modifier.domains = [...domains];
            modifier.adjustments = extractModifierAdjustments(adjustmentsRecord, domains, modifier.slug);
            modifier.alterations = extractDamageAlterations(alterationsRecord, domains, modifier.slug);
        }

        // Attach modifier adjustments from property runes
        for (const modifier of modifiers) {
            const propRuneAdjustments = propertyRuneAdjustments.filter((a) => a.slug === modifier.slug);
            modifier.adjustments.push(...propRuneAdjustments);
        }

        // Collect damage alterations for non-synthetic damage
        for (const dice of damageDice) {
            dice.alterations = extractDamageAlterations(alterationsRecord, domains, dice.slug);
        }

        // Synthetics
        const extractOptions = {
            selectors: domains,
            test: options,
            resolvables: { weapon, target: context.target?.actor ?? null },
            injectables: { weapon },
        };
        const extracted = processDamageCategoryStacking(base, {
            modifiers: [modifiers, extractModifiers(actor.synthetics, domains, extractOptions)].flat(),
            dice: extractDamageDice(actor.synthetics.damageDice, extractOptions),
            test: options,
        });

        const testedModifiers = extracted.modifiers;
        damageDice.push(...extracted.dice);

        // Apply damage alterations
        for (const dice of damageDice) {
            dice.applyAlterations({ item: weapon, test: options });
        }
        for (const modifier of testedModifiers) {
            modifier.applyDamageAlterations({ item: weapon, test: options });
        }
        const maxIncreases = weapon.isOfType("weapon") && weapon.flags.pf2e.damageFacesUpgraded ? 0 : 1;

        const formulaData: DamageFormulaData = {
            base,
            // CRB p. 279, Counting Damage Dice: Effects based on a weapon's number of damage dice include
            // only the weapon's damage die plus any extra dice from a striking rune. They don't count
            // extra dice from abilities, critical specialization effects, property runes, weapon traits,
            // or the like.
            dice: damageDice,
            maxIncreases,
            modifiers: testedModifiers,
            ignoredResistances,
        };

        // If a weapon deals no base damage, remove all bonuses, penalties, and modifiers to it.
        if (!(formulaData.base[0].diceNumber || formulaData.base[0].modifier)) {
            formulaData.dice = formulaData.dice.filter((d) => ![null, "precision"].includes(d.category));
            formulaData.modifiers = formulaData.modifiers.filter((m) => ![null, "precision"].includes(m.category));
        }

        const excludeFrom = weapon.isOfType("weapon") ? weapon : null;
        this.#excludeDamage({ actor, weapon: excludeFrom, modifiers: [...testedModifiers, ...damageDice], options });

        if (!context.skipDialog) {
            const rolled = await new DamageModifierDialog({ formulaData, context }).resolve();
            if (!rolled) return null;
        }

        const computedFormulas = {
            criticalFailure: null,
            failure: createDamageFormula(formulaData, DEGREE_OF_SUCCESS.FAILURE),
            success: createDamageFormula(formulaData, DEGREE_OF_SUCCESS.SUCCESS),
            criticalSuccess: createDamageFormula(formulaData, DEGREE_OF_SUCCESS.CRITICAL_SUCCESS),
        };

        return {
            name: `${game.i18n.localize("PF2E.DamageRoll")}: ${weapon.name}`,
            materials: Array.from(materials),
            modifiers: [...damageDice, ...testedModifiers],
            damage: {
                ...formulaData,
                formula: mapValues(computedFormulas, (formula) => formula?.formula ?? null),
                breakdown: mapValues(computedFormulas, (formula) => formula?.breakdown ?? []),
            },
        };
    }

    /**
     * Retrieve exclusion terms from rule elements. Any term is not in the `any` or `all` predicate,
     * it is added to the `not` predicate
     */
    static #excludeDamage({ actor, modifiers, weapon, options }: ExcludeDamageParams): void {
        if (!weapon) return;

        const notIgnored = modifiers.filter((modifier) => !modifier.ignored);
        for (const rule of actor.rules) {
            rule.applyDamageExclusion?.(weapon, notIgnored);
        }
        for (const modifier of notIgnored) {
            modifier.ignored = !modifier.predicate.test(options);
        }
    }

    /** Parse damage formulas from melee items and construct `WeaponDamage` objects out of them */
    static npcDamageToWeaponDamage(instance: NPCAttackDamage): ConvertedNPCDamage {
        // Despite it being a string formula, melee items only support a single dice and modifier term
        const terms = parseTermsFromSimpleFormula(instance.damage);
        const die = terms.find((t) => t.dice)?.dice;
        const modifier = terms.find((t) => t.modifier)?.modifier ?? 0;

        return {
            dice: die?.number ?? 0,
            die: die?.faces ? (`d${die.faces}` as DamageDieSize) : null,
            modifier,
            damageType: instance.damageType,
            persistent: null,
            category: instance.category,
        };
    }
}

interface ConvertedNPCDamage extends WeaponDamage {
    category: DamageCategoryUnique | null;
}

interface WeaponDamageCalculateParams {
    weapon: WeaponPF2e<ActorPF2e> | MeleePF2e<ActorPF2e>;
    actor: ActorPF2e;
    weaponPotency?: PotencySynthetic | null;
    damageDice?: DamageDicePF2e[];
    modifiers?: ModifierPF2e[];
    context: DamageDamageContext;
}

interface NPCStrikeCalculateParams {
    attack: MeleePF2e<ActorPF2e>;
    actor: ActorPF2e;
    context: DamageDamageContext;
}

interface ExcludeDamageParams {
    actor: ActorPF2e;
    modifiers: (DamageDicePF2e | ModifierPF2e)[];
    weapon: WeaponPF2e | null;
    options: Set<string>;
}

export { WeaponDamagePF2e, type ConvertedNPCDamage };
