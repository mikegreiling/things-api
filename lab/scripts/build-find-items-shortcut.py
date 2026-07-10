#!/usr/bin/env python3
"""Build the repaired things-proxy-find-items unsigned .wflow (old-format plist).

The envelope is byte-derived from the CURRENT committed signed asset (its
AEA payload — profile 0, signed-not-encrypted — extracted with
`aea decrypt -sign-pub <leaf-cert pubkey>` + `aa extract` → Shortcut.wflow),
whose import was validated on real hardware 2026-07-10. Only
WFWorkflowActions changes: the SX5-validated repair (filter row
Property "title" / Operator 4 / Unit 4 bound to dict key "search",
stray WFContentItemInputParameter dropped, Limit 1) replaces the
echo-bug actions.

Usage: build-find-items-shortcut.py <orig-ZDATA.blob> <out.wflow>

Then sign on the host (signer sandbox cannot write to /Volumes/*):
  shortcuts sign --mode anyone -i /tmp/x.wflow -o /tmp/x.shortcut
  mv /tmp/x.shortcut shortcuts/things-proxy-find-items.shortcut
("debugDescription" ObjC stderr noise is harmless.)
"""
import plistlib
import sys
import copy

orig_blob, out_path = sys.argv[1], sys.argv[2]

actions = plistlib.load(open(orig_blob, "rb"))
assert actions[1]["WFWorkflowActionIdentifier"] == "com.culturedcode.ThingsMac.TAIItemEntity"
DICT_UUID = actions[0]["WFWorkflowActionParameters"]["UUID"]

# --- the SX5-validated repair (v-title-is) ---------------------------------
repaired = copy.deepcopy(actions)
p = repaired[1]["WFWorkflowActionParameters"]
p.pop("WFContentItemInputParameter", None)
p["WFContentItemLimitEnabled"] = True
p["WFContentItemLimitNumber"] = 1.0
p["WFContentItemFilter"] = {
    "Value": {
        "WFActionParameterFilterPrefix": 1,
        "WFContentPredicateBoundedDate": False,
        "WFActionParameterFilterTemplates": [
            {
                "Property": "title",
                "Operator": 4,  # "is" (case-insensitive, SX5-1)
                "Removable": True,
                "Values": {
                    "Unit": 4,
                    "String": {
                        "Value": {
                            "string": "￼",
                            "attachmentsByRange": {
                                "{0, 1}": {
                                    "Type": "ActionOutput",
                                    "OutputName": "Dictionary",
                                    "OutputUUID": DICT_UUID,
                                    "Aggrandizements": [
                                        {
                                            "Type": "WFDictionaryValueVariableAggrandizement",
                                            "DictionaryKey": "search",
                                        }
                                    ],
                                }
                            },
                        },
                        "WFSerializationType": "WFTextTokenString",
                    },
                },
            }
        ],
    },
    "WFSerializationType": "WFContentPredicateTableTemplate",
}

# --- the known-good envelope (from the committed asset's AEA payload) -------
INPUT_CLASSES = [
    "WFAppContentItem", "WFAppStoreAppContentItem", "WFArticleContentItem",
    "WFContactContentItem", "WFDateContentItem", "WFEmailAddressContentItem",
    "WFFolderContentItem", "WFGenericFileContentItem", "WFImageContentItem",
    "WFiTunesProductContentItem", "WFLocationContentItem",
    "WFDCMapsLinkContentItem", "WFAVAssetContentItem", "WFPDFContentItem",
    "WFPhoneNumberContentItem", "WFRichTextContentItem",
    "WFSafariWebPageContentItem", "WFStringContentItem", "WFURLContentItem",
]

wflow = {
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowIcon": {
        "WFWorkflowIconStartColor": 431817727,
        "WFWorkflowIconGlyphNumber": 61440,
    },
    "WFWorkflowClientVersion": "3612.0.2.5",
    "WFWorkflowOutputContentItemClasses": [
        "WFLinkEntityContentItem_com.culturedcode.ThingsMac_TAIItemEntity"
    ],
    "WFWorkflowHasOutputFallback": False,
    "WFWorkflowActions": repaired,
    "WFWorkflowInputContentItemClasses": INPUT_CLASSES,
    "WFWorkflowImportQuestions": [],
    "WFQuickActionSurfaces": [],
    "WFWorkflowTypes": [],
    "WFWorkflowHasShortcutInputVariables": True,
}

with open(out_path, "wb") as f:
    plistlib.dump(wflow, f, fmt=plistlib.FMT_BINARY)
print("wrote", out_path)
