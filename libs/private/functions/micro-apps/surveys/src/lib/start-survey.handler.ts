import { HandlerTools } from '@iote/cqrs';
import { FunctionHandler, FunctionContext } from '@ngfi/functions';
import { Query } from '@ngfi/firestore-qbuilder';

import { StartSurveyReq, StartSurveyResponse } from '@app/private/model/convs-mgr/micro-apps/surveys';
import { BlockDataService, ChannelDataService, ConnectionsDataService, CursorDataService, EnrolledUserDataService } from '@app/functions/bot-engine';
import { CommunicationChannel, Cursor, EndUserPosition, PlatformType, SurveyCursor } from '@app/model/convs-mgr/conversations/admin/system';
import { SendOutgoingMsgHandler } from '@app/functions/bot-engine/send-message';
import { StoryBlock } from '@app/model/convs-mgr/stories/blocks/main';
import { BlockToStandardMessage } from 'libs/functions/bot-engine/main/src/lib/io/block-to-message-parser.class';
import { Message } from '@app/model/convs-mgr/conversations/messages';

export class StartSurveyHandler extends FunctionHandler<StartSurveyReq, StartSurveyResponse>
{
  public async execute(req: StartSurveyReq, context: FunctionContext, tools: HandlerTools)
  {
    try {
      const channelService = new ChannelDataService(tools);
      const sendMessage =  new SendOutgoingMsgHandler();
      const commChannel = await channelService.getChannelInfo(req.channelId);

      let messageToSend: Message;

      // Set the new user position
      const newUserPosition: EndUserPosition = {
        storyId: req.surveyId,
        blockId: null,
      }
  
      // Get the message template
      if (req.messageTemplateName) {
        const templatesRepo$ = tools.getRepository<any>(`orgs/${commChannel.orgId}/message-templates`);
  
        messageToSend = (await templatesRepo$.getDocuments(new Query().where('name', '==', req.messageTemplateName)))[0];
      } else {
        // If no template is defined we just send the first question in the survey to the user
        //   However this may fail to reach some users due to the 24 hour limit
        const {message, blockId} = await this._getFirstMessageInSurvey(req.surveyId, commChannel, tools);

        messageToSend = message;
        newUserPosition.blockId = blockId;
      }
  
      let count = 0;
  
      // Update the cursor
      for (let id of req.enrolledUserIds) {
        const {endUserId, receiveID} = await this._getEndUserId(id, commChannel.type, commChannel.orgId, tools);
  
        const cursorService = new CursorDataService(tools);
        const latestCursor = await cursorService.getLatestCursor(endUserId, commChannel.orgId);
        let newCursor: Cursor;
  
        if (latestCursor) {
          const cursor = latestCursor as Cursor;
          const surveyCursor = {
            surveyId: req.surveyId,
            savedUserPosition: cursor.position
          } as SurveyCursor;
  
           newCursor = {
            ...cursor,
            position: newUserPosition
          } as Cursor;
  
          if (!newCursor.surveyStack && newCursor.surveyStack.length < 1) {
            newCursor.surveyStack = [surveyCursor];
          } else {
            newCursor.surveyStack.unshift(surveyCursor);
          }
  
        } else {
          // If the user has not texted the bot yet
          // Creat a new cursor and append the survey stack
          
           newCursor = {
            position: newUserPosition
          }
          
          newCursor.surveyStack = [{ 
            surveyId: req.surveyId,
            savedUserPosition: null
          }];
        }
        
        // Update the cursor document with the user position at the survey
        await cursorService.updateCursor(endUserId, commChannel.orgId, newCursor);
  
        // Send the template message to the users
        messageToSend.n = commChannel.n;
        messageToSend = this._setReceiveID(commChannel.type, receiveID, messageToSend);
  
        await sendMessage.execute(messageToSend, null, tools);
        
        count++;
      }
  
      return {messagesSent: count, success: true } as StartSurveyResponse;
    } catch (error) {
      tools.Logger.log(()=> `[StartSurveyHandler].execute - Error sending survey: ${error}`)
      return {success: false} as StartSurveyResponse;
    }
  }

  private async _getEndUserId(enrolledUserId: string, platform: PlatformType, orgId: string, tools: HandlerTools): Promise<{endUserId: string, receiveID: string}>
  {
    const enrolledUserService = new EnrolledUserDataService(tools, orgId);

    const enrolledUser = await enrolledUserService.getEnrolledUser(enrolledUserId);

    if (platform == PlatformType.WhatsApp) {
      return {endUserId: enrolledUser.whatsappUserId, receiveID: enrolledUser.whatsappUserId.split("_")[2]};
    } else {
      return {endUserId: enrolledUser.messengerUserId, receiveID: enrolledUser.messengerUserId.split("_")[2]};
    }
  }

  private _setReceiveID(platform: PlatformType, receiveID: string, message: any) {
    if (platform == PlatformType.WhatsApp) {
      message.endUserPhoneNumber = receiveID;
      return message;
    } else {
      message.receipientId = receiveID;
      return message;
    }
  }
  
  private async _getFirstMessageInSurvey(surveyId: string, commChannel: CommunicationChannel, tools: HandlerTools) {
    const connService = new ConnectionsDataService(commChannel, tools);
    const blockService = new BlockDataService(commChannel, connService, tools)

    // Get the first block
    const firstBlock = await blockService.getFirstBlock(commChannel.orgId, surveyId);

    // Convert to message and return
    const message = new BlockToStandardMessage().convert(firstBlock);
    return {message, blockId: firstBlock.id};
  }
}